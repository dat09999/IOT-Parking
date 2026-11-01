#include <Arduino.h>
#include <Wire.h>
#include <ESP32Servo.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// Smart parking model: 3 spaces, entry and exit gates.
// LEDs and Blynk are intentionally not implemented in this sketch.

// GPIO map transcribed from the project diagram/document.
constexpr uint8_t PIN_P1_SENSOR = 32;
constexpr uint8_t PIN_P2_SENSOR = 33;
constexpr uint8_t PIN_P3_SENSOR = 34;
constexpr uint8_t PIN_ENTRY_SENSOR = 35;
constexpr uint8_t PIN_EXIT_SENSOR = 36;
constexpr uint8_t PIN_ENTRY_SERVO = 25;
constexpr uint8_t PIN_EXIT_SERVO = 26;
constexpr uint8_t PIN_BUZZER = 27;
constexpr uint8_t PIN_OLED_SDA = 21;
constexpr uint8_t PIN_OLED_SCL = 22;

// LM393 IR boards differ: set true if OUT is LOW when an object is detected.
// Confirm this with SensorIRTest.ino before the first full run.
constexpr bool IR_ACTIVE_LOW = true;

// Adjust these angles to match the physical arm installation.
constexpr int ENTRY_CLOSED_ANGLE = 0;
constexpr int ENTRY_OPEN_ANGLE = 90;
constexpr int EXIT_CLOSED_ANGLE = 0;
constexpr int EXIT_OPEN_ANGLE = 90;

constexpr uint32_t SENSOR_DEBOUNCE_MS = 350;
constexpr uint32_t GATE_CLOSE_CLEAR_MS = 1000;
constexpr uint32_t GATE_MAX_OPEN_MS = 10000;
constexpr uint32_t OLED_REFRESH_MS = 300;
constexpr uint32_t FULL_BEEP_INTERVAL_MS = 1800;
constexpr uint8_t OLED_WIDTH = 128;
constexpr uint8_t OLED_HEIGHT = 64;
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
bool displayReady = false;
bool buzzerOn = false;
uint32_t buzzerOffAt = 0;
uint32_t lastFullBeepAt = 0;
uint32_t lastDisplayAt = 0;
uint8_t freeSlots = 3;
bool parkingFull = false;

// These states are available for the teammate who integrates Blynk later.
// The local parking control below does not depend on network connectivity.
bool occupiedP1 = false;
bool occupiedP2 = false;
bool occupiedP3 = false;
bool entryGateOpen = false;
bool exitGateOpen = false;

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

void updateGate(GateController &gate, bool vehicleAtGate, bool isEntry,
                uint32_t now) {
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

  // Keep the barrier open while a vehicle is detected. Close only after the
  // beam has stayed clear for the safety interval. If it times out while a
  // vehicle is still present, report it and keep the barrier open.
  if (vehicleAtGate) {
    gate.waitingForClear = false;
    if (now - gate.openedAt >= GATE_MAX_OPEN_MS && !gate.timeoutReported) {
      gate.timeoutReported = true;
      Serial.println(isEntry ? "Entry gate timeout: sensor still occupied; keeping gate open."
                             : "Exit gate timeout: sensor still occupied; keeping gate open.");
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
  display.println(F("Bai do xe"));
  display.print(F("Con trong: "));
  display.println(freeSlots);
  display.print(F("P1:")); display.print(occupiedP1 ? F("XE ") : F("TRONG "));
  display.print(F("P2:")); display.println(occupiedP2 ? F("XE") : F("TRONG"));
  display.print(F("P3:")); display.println(occupiedP3 ? F("XE") : F("TRONG"));
  display.print(F("Vao: ")); display.print(entryGateOpen ? F("MO") : F("DONG"));
  display.print(F(" Ra: ")); display.println(exitGateOpen ? F("MO") : F("DONG"));
  if (parkingFull) display.println(F("BAI XE DAY"));
  display.display();
}

void printStateToSerial() {
  Serial.print(F("P1=")); Serial.print(occupiedP1);
  Serial.print(F(" P2=")); Serial.print(occupiedP2);
  Serial.print(F(" P3=")); Serial.print(occupiedP3);
  Serial.print(F(" free=")); Serial.print(freeSlots);
  Serial.print(F(" entryGate=")); Serial.print(entryGateOpen ? F("OPEN") : F("CLOSED"));
  Serial.print(F(" exitGate=")); Serial.println(exitGateOpen ? F("OPEN") : F("CLOSED"));
}

void setup() {
  Serial.begin(115200);
  for (uint8_t i = 0; i < SENSOR_COUNT; ++i) {
    // GPIO34/35/36 are input-only and have no internal pull-up/down.
    // The LM393 module must provide a valid driven OUT signal.
    pinMode(SENSOR_PINS[i], INPUT);
    sensors[i].rawDetected = readDetected(SENSOR_PINS[i]);
    sensors[i].stableDetected = sensors[i].rawDetected;
    sensors[i].rawChangedAt = millis();
  }
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);
  displayReady = display.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDRESS);
  if (!displayReady) Serial.println(F("OLED not found; check power, SDA/SCL and I2C address."));

  entryServo.attach(PIN_ENTRY_SERVO, 500, 2400);
  exitServo.attach(PIN_EXIT_SERVO, 500, 2400);
  entryServo.write(ENTRY_CLOSED_ANGLE);
  exitServo.write(EXIT_CLOSED_ANGLE);
  entryGateOpen = false;
  exitGateOpen = false;

  updateParkingStatus();
  if (displayReady) {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println(F("Bai do xe san sang"));
    display.display();
  }
  Serial.println(F("Smart parking local control ready. Blynk is not included here."));
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

  static uint32_t lastSerialAt = 0;
  if (now - lastSerialAt >= 1000) {
    lastSerialAt = now;
    printStateToSerial();
  }
}
