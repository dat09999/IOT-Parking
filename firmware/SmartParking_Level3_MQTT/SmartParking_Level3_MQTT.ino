/**
 * ==============================================================================
 * DU AN: HE THONG QUAN LY BAI DO XE THONG MINH - IOT CAP DO 3 (BAN GIAO THUC MQTT)
 * Su dung thu vien: PubSubClient de truyen thong hai chieu voi Broker MQTT
 * ==============================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <ESP32Servo.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ================= THONG TIN CAU HINH WIFI VA BROKER MQTT =================
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// IP may tinh dang chay Server Node.js (Tich hop san MQTT Broker cong 1883)
const char* MQTT_BROKER   = "192.168.1.14"; 
const int   MQTT_PORT     = 1883;

// Topics MQTT
const char* TOPIC_TELEMETRY = "smartparking/telemetry"; // ESP32 gui du lieu len Web
const char* TOPIC_CONTROL   = "smartparking/control";   // Web gui lenh dieu khien xuong ESP32

WiFiClient espClient;
PubSubClient mqttClient(espClient);

// ================= PHAN CUNG =================
constexpr uint8_t PIN_P1_SENSOR    = 32;
constexpr uint8_t PIN_P2_SENSOR    = 33;
constexpr uint8_t PIN_P3_SENSOR    = 34;
constexpr uint8_t PIN_ENTRY_SENSOR = 35;
constexpr uint8_t PIN_EXIT_SENSOR  = 36;
constexpr uint8_t PIN_ENTRY_SERVO  = 25;
constexpr uint8_t PIN_EXIT_SERVO   = 26;
constexpr uint8_t PIN_BUZZER       = 27;
constexpr uint8_t PIN_OLED_SDA     = 21;
constexpr uint8_t PIN_OLED_SCL     = 22;

constexpr bool IR_ACTIVE_LOW       = true;

constexpr int ENTRY_CLOSED_ANGLE   = 0;
constexpr int ENTRY_OPEN_ANGLE     = 90;
constexpr int EXIT_CLOSED_ANGLE    = 0;
constexpr int EXIT_OPEN_ANGLE      = 90;

constexpr uint32_t SENSOR_DEBOUNCE_MS   = 350;
constexpr uint32_t GATE_CLOSE_CLEAR_MS  = 1000;
constexpr uint32_t GATE_MAX_OPEN_MS     = 10000;
constexpr uint32_t OLED_REFRESH_MS      = 300;
constexpr uint32_t FULL_BEEP_INTERVAL_MS= 1800;
constexpr uint32_t MQTT_PUB_INTERVAL_MS = 1500;

constexpr uint8_t OLED_WIDTH       = 128;
constexpr uint8_t OLED_HEIGHT      = 64;
constexpr uint8_t OLED_I2C_ADDRESS = 0x3C;

Adafruit_SSD1306 display(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);
Servo entryServo;
Servo exitServo;

enum SensorIndex : uint8_t {
  SENSOR_P1,
  SENSOR_P2,
  SENSOR_P3,
  SENSOR_ENTRY,
  SENSOR_EXIT,
  SENSOR_COUNT
};

const uint8_t SENSOR_PINS[SENSOR_COUNT] = {
  PIN_P1_SENSOR, PIN_P2_SENSOR, PIN_P3_SENSOR,
  PIN_ENTRY_SENSOR, PIN_EXIT_SENSOR
};

struct DebouncedSensor {
  bool rawDetected = false;
  bool stableDetected = false;
  uint32_t rawChangedAt = 0;
};

enum GateState : uint8_t { GATE_CLOSED, GATE_OPEN };

struct GateController {
  GateState state = GATE_CLOSED;
  uint32_t openedAt = 0;
  uint32_t clearSince = 0;
  bool waitingForClear = false;
  bool timeoutReported = false;
};

DebouncedSensor sensors[SENSOR_COUNT];
GateController entryGate;
GateController exitGate;

bool displayReady     = false;
bool buzzerOn         = false;
uint32_t buzzerOffAt  = 0;
uint32_t lastFullBeepAt  = 0;
uint32_t lastDisplayAt   = 0;
uint32_t lastMqttPubAt   = 0;

uint8_t freeSlots    = 3;
bool parkingFull     = false;
bool occupiedP1      = false;
bool occupiedP2      = false;
bool occupiedP3      = false;
bool entryGateOpen   = false;
bool exitGateOpen    = false;

bool lastSyncedP1    = false;
bool lastSyncedP2    = false;
bool lastSyncedP3    = false;
bool lastSyncedEntry = false;
bool lastSyncedExit  = false;

bool readDetected(uint8_t pin) {
  const int level = digitalRead(pin);
  return IR_ACTIVE_LOW ? (level == LOW) : (level == HIGH);
}

void updateSensor(DebouncedSensor &sensor, uint8_t pin, uint32_t now) {
  const bool reading = readDetected(pin);
  if (reading != sensor.rawDetected) {
    sensor.rawDetected = reading;
    sensor.rawChangedAt = now;
  }
  if (sensor.stableDetected != sensor.rawDetected &&
      now - sensor.rawChangedAt >= SENSOR_DEBOUNCE_MS) {
    sensor.stableDetected = sensor.rawDetected;
  }
}

void startBeep(uint16_t durationMs) {
  digitalWrite(PIN_BUZZER, HIGH);
  buzzerOn = true;
  buzzerOffAt = millis() + durationMs;
}

void updateBuzzer(uint32_t now) {
  if (buzzerOn && static_cast<int32_t>(now - buzzerOffAt) >= 0) {
    digitalWrite(PIN_BUZZER, LOW);
    buzzerOn = false;
  }
}

void setEntryGate(bool open, uint32_t now) {
  if (open) {
    entryServo.write(ENTRY_OPEN_ANGLE);
    entryGate.state = GATE_OPEN;
    entryGate.openedAt = now;
    entryGate.waitingForClear = false;
    entryGate.timeoutReported = false;
  } else {
    entryServo.write(ENTRY_CLOSED_ANGLE);
    entryGate.state = GATE_CLOSED;
    entryGate.waitingForClear = false;
  }
  entryGateOpen = open;
}

void setExitGate(bool open, uint32_t now) {
  if (open) {
    exitServo.write(EXIT_OPEN_ANGLE);
    exitGate.state = GATE_OPEN;
    exitGate.openedAt = now;
    exitGate.waitingForClear = false;
    exitGate.timeoutReported = false;
  } else {
    exitServo.write(EXIT_CLOSED_ANGLE);
    exitGate.state = GATE_CLOSED;
    exitGate.waitingForClear = false;
  }
  exitGateOpen = open;
}

void updateParkingStatus() {
  occupiedP1 = sensors[SENSOR_P1].stableDetected;
  occupiedP2 = sensors[SENSOR_P2].stableDetected;
  occupiedP3 = sensors[SENSOR_P3].stableDetected;
  const uint8_t occupiedCount = static_cast<uint8_t>(occupiedP1) +
                                static_cast<uint8_t>(occupiedP2) +
                                static_cast<uint8_t>(occupiedP3);
  freeSlots = 3 - occupiedCount;
  parkingFull = (freeSlots == 0);
}

void updateGate(GateController &gate, bool vehicleAtGate, bool isEntry, uint32_t now) {
  if (gate.state == GATE_CLOSED) {
    if (vehicleAtGate) {
      if (isEntry && parkingFull) {
        if (!buzzerOn && now - lastFullBeepAt >= FULL_BEEP_INTERVAL_MS) {
          startBeep(250);
          lastFullBeepAt = now;
        }
      } else {
        if (isEntry) setEntryGate(true, now);
        else setExitGate(true, now);
        startBeep(90);
      }
    }
    return;
  }

  if (vehicleAtGate) {
    gate.waitingForClear = false;
    if (now - gate.openedAt >= GATE_MAX_OPEN_MS && !gate.timeoutReported) {
      gate.timeoutReported = true;
      startBeep(500);
    }
  } else {
    if (!gate.waitingForClear) {
      gate.waitingForClear = true;
      gate.clearSince = now;
    } else if (now - gate.clearSince >= GATE_CLOSE_CLEAR_MS) {
      if (isEntry) setEntryGate(false, now);
      else setExitGate(false, now);
      return;
    }
  }
}

void updateDisplay(uint32_t now) {
  if (!displayReady || now - lastDisplayAt < OLED_REFRESH_MS) return;
  lastDisplayAt = now;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(F("IoT Level-3 "));
  display.println(mqttClient.connected() ? F("[MQTT OK]") : F("[NO MQTT]"));
  display.print(F("Con trong: "));
  display.println(freeSlots);
  display.print(F("P1:")); display.print(occupiedP1 ? F("XE ") : F("TRG "));
  display.print(F("P2:")); display.print(occupiedP2 ? F("XE ") : F("TRG "));
  display.print(F("P3:")); display.println(occupiedP3 ? F("XE") : F("TRG"));
  display.print(F("Vao:")); display.print(entryGateOpen ? F("MO ") : F("DONG "));
  display.print(F("Ra:")); display.println(exitGateOpen ? F("MO") : F("DONG"));
  if (parkingFull) display.println(F(">>> BAI XE DAY <<<"));
  display.display();
}

// ================= XU LY TIN HIEU DIEU KHIEN MQTT TU WEB =================
void mqttCallback(char* topic, byte* message, unsigned int length) {
  String messageTemp;
  for (int i = 0; i < length; i++) {
    messageTemp += (char)message[i];
  }
  Serial.printf("[MQTT RECV] Topic: %s, Message: %s\n", topic, messageTemp.c_str());

  if (messageTemp.indexOf("OPEN_ENTRY") >= 0) {
    Serial.println("[MQTT] Lenh mo cong vao!");
    setEntryGate(true, millis());
    startBeep(120);
  } else if (messageTemp.indexOf("OPEN_EXIT") >= 0) {
    Serial.println("[MQTT] Lenh mo cong ra!");
    setExitGate(true, millis());
    startBeep(120);
  } else if (messageTemp.indexOf("TRIGGER_BUZZER") >= 0) {
    Serial.println("[MQTT] Lenh bao coi!");
    startBeep(800);
  }
}

void reconnectMqtt() {
  static uint32_t lastTry = 0;
  if (!mqttClient.connected() && millis() - lastTry > 4000) {
    lastTry = millis();
    Serial.print("Ket noi MQTT Broker...");
    String clientId = "ESP32_SmartParking_" + String(random(0xffff), HEX);
    if (mqttClient.connect(clientId.c_str())) {
      Serial.println(" Thanh cong!");
      mqttClient.subscribe(TOPIC_CONTROL);
    } else {
      Serial.printf(" That bai, rc=%d\n", mqttClient.state());
    }
  }
}

void publishTelemetryMqtt() {
  if (!mqttClient.connected()) return;

  String payload = "{";
  payload += "\"p1\":" + String(occupiedP1 ? 1 : 0) + ",";
  payload += "\"p2\":" + String(occupiedP2 ? 1 : 0) + ",";
  payload += "\"p3\":" + String(occupiedP3 ? 1 : 0) + ",";
  payload += "\"entryGate\":" + String(entryGateOpen ? 1 : 0) + ",";
  payload += "\"exitGate\":" + String(exitGateOpen ? 1 : 0) + ",";
  payload += "\"free\":" + String(freeSlots);
  payload += "}";

  mqttClient.publish(TOPIC_TELEMETRY, payload.c_str());

  lastSyncedP1    = occupiedP1;
  lastSyncedP2    = occupiedP2;
  lastSyncedP3    = occupiedP3;
  lastSyncedEntry = entryGateOpen;
  lastSyncedExit  = exitGateOpen;
}

void setup() {
  Serial.begin(115200);
  for (uint8_t i = 0; i < SENSOR_COUNT; ++i) {
    pinMode(SENSOR_PINS[i], INPUT);
    sensors[i].rawDetected = readDetected(SENSOR_PINS[i]);
    sensors[i].stableDetected = sensors[i].rawDetected;
    sensors[i].rawChangedAt = millis();
  }
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);
  displayReady = display.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDRESS);

  entryServo.attach(PIN_ENTRY_SERVO, 500, 2400);
  exitServo.attach(PIN_EXIT_SERVO, 500, 2400);
  entryServo.write(ENTRY_CLOSED_ANGLE);
  exitServo.write(EXIT_CLOSED_ANGLE);

  updateParkingStatus();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
}

void loop() {
  const uint32_t now = millis();

  for (uint8_t i = 0; i < SENSOR_COUNT; ++i) {
    updateSensor(sensors[i], SENSOR_PINS[i], now);
  }
  updateParkingStatus();
  updateGate(entryGate, sensors[SENSOR_ENTRY].stableDetected, true, now);
  updateGate(exitGate, sensors[SENSOR_EXIT].stableDetected, false, now);
  updateBuzzer(now);
  updateDisplay(now);

  // MQTT loop
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqttClient.connected()) {
      reconnectMqtt();
    } else {
      mqttClient.loop();
    }
  }

  const bool stateChanged = (occupiedP1 != lastSyncedP1) ||
                            (occupiedP2 != lastSyncedP2) ||
                            (occupiedP3 != lastSyncedP3) ||
                            (entryGateOpen != lastSyncedEntry) ||
                            (exitGateOpen != lastSyncedExit);

  if (stateChanged || (now - lastMqttPubAt >= MQTT_PUB_INTERVAL_MS)) {
    lastMqttPubAt = now;
    publishTelemetryMqtt();
  }
}
