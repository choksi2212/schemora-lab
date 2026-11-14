import { z } from 'zod';

const httpsUrl = z
  .string()
  .url()
  .refine(
    (value) => new URL(value).protocol === 'https:',
    'Board directory sources must use HTTPS.',
  );

const boardDirectoryEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]+$/),
    manufacturer: z.enum([
      'Adafruit',
      'Arduino',
      'Espressif Systems',
      'Raspberry Pi',
      'SparkFun Electronics',
      'STMicroelectronics',
    ]),
    sourceId: z.string().min(1),
    family: z.string().min(1),
    model: z.string().min(1),
    processorFamily: z.string().min(1),
    recordType: z.enum(['development-board', 'system-module', 'industrial-controller']),
    listingStatus: z.enum(['listed', 'end-of-life', 'legacy']),
    productUrl: httpsUrl,
    documentationUrl: httpsUrl.nullable(),
    orderableVariants: z.array(z.string().min(1)),
    variantCoverage: z.enum(['selected-only', 'not-reviewed']),
    supportLevel: z.literal('discovery-only'),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.variantCoverage === 'selected-only' && entry.orderableVariants.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['orderableVariants'],
        message: 'Selected-only coverage must include at least one named variant.',
      });
    }
    if (entry.variantCoverage === 'not-reviewed' && entry.orderableVariants.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['orderableVariants'],
        message: 'Unreviewed variant coverage cannot publish variant values.',
      });
    }
  });

export const boardDirectorySchema = z
  .object({
    schemaVersion: z.literal(1),
    directoryId: z.literal('schemora-board-directory-2026.11'),
    checkedOn: z.string().date(),
    status: z.literal('discovery-index'),
    coverageNote: z.string().min(1),
    sources: z
      .array(
        z
          .object({
            id: z.string().min(1),
            manufacturer: z.enum([
              'Adafruit',
              'Arduino',
              'Espressif Systems',
              'Raspberry Pi',
              'SparkFun Electronics',
              'STMicroelectronics',
            ]),
            title: z.string().min(1),
            url: httpsUrl,
            checkedOn: z.string().date(),
          })
          .strict(),
      )
      .min(1),
    entries: z.array(boardDirectoryEntrySchema).min(1),
  })
  .strict()
  .superRefine((directory, ctx) => {
    const sourceIds = new Set(directory.sources.map((source) => source.id));
    if (sourceIds.size !== directory.sources.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'Board directory source IDs must be unique.',
      });
    }
    const entryIds = directory.entries.map((entry) => entry.id);
    if (new Set(entryIds).size !== entryIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['entries'],
        message: 'Board directory entry IDs must be unique.',
      });
    }
    for (const [index, entry] of directory.entries.entries()) {
      const expectedManufacturer: Record<string, string> = {
        Adafruit: 'adafruit',
        Arduino: 'arduino',
        'Espressif Systems': 'espressif',
        'Raspberry Pi': 'raspberry-pi',
        'SparkFun Electronics': 'sparkfun',
        STMicroelectronics: 'st',
      };
      if (!entry.id.startsWith(`${expectedManufacturer[entry.manufacturer]}.`)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index, 'id'],
          message: 'Entry ID prefix must identify its manufacturer.',
        });
      }
      if (!sourceIds.has(entry.sourceId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sources'],
          message: `Unknown directory source ${entry.sourceId} for ${entry.manufacturer}.`,
        });
      }
    }
  });

const espDirectory = 'https://www.espressif.com/en/products/devkits';
const arduinoDirectory = 'https://www.arduino.cc/hardware';
const arduinoOlderDirectory = 'https://www.arduino.cc/en/Main/Hardware';
const arduinoRetiredDirectory = 'https://docs.arduino.cc/retired/';
const raspberryPiPicoDirectory =
  'https://www.raspberrypi.com/documentation/microcontrollers/pico-series.html';
const stNucleoDirectory =
  'https://www.st.com/en/evaluation-tools/stm32-nucleo-boards/products.html';
const adafruitDirectory = 'https://www.adafruit.com/category/851';
const sparkfunDirectory = 'https://www.sparkfun.com/development-boards.html';
const espDocs = (path: string) =>
  `https://docs.espressif.com/projects/esp-dev-kits/en/latest/${path}`;
const arduinoDocs = (path: string) => `https://docs.arduino.cc/hardware/${path}/`;

const esp = (
  id: string,
  family: string,
  model: string,
  processorFamily: string,
  documentationUrl: string | null = null,
) => ({
  id: `espressif.${id}`,
  manufacturer: 'Espressif Systems' as const,
  sourceId: 'espressif',
  family,
  model,
  processorFamily,
  recordType: 'development-board' as const,
  listingStatus: 'listed' as const,
  productUrl: espDirectory,
  documentationUrl,
  orderableVariants: [],
  variantCoverage: 'not-reviewed' as const,
  supportLevel: 'discovery-only' as const,
});

const arduino = (
  id: string,
  family: string,
  model: string,
  processorFamily: string,
  recordType: 'development-board' | 'system-module' | 'industrial-controller',
  listingStatus: 'listed' | 'end-of-life' | 'legacy' = 'listed',
  documentationUrl: string | null = null,
  orderableVariants: string[] = [],
) => ({
  id: `arduino.${id}`,
  manufacturer: 'Arduino' as const,
  sourceId: 'arduino',
  family,
  model,
  processorFamily,
  recordType,
  listingStatus,
  productUrl: arduinoDirectory,
  documentationUrl,
  orderableVariants,
  variantCoverage: orderableVariants.length
    ? ('selected-only' as const)
    : ('not-reviewed' as const),
  supportLevel: 'discovery-only' as const,
});

const arduinoLegacyIndex = (
  id: string,
  family: string,
  model: string,
  processorFamily = 'Not recorded in the board index',
) => ({
  ...arduino(id, family, model, processorFamily, 'development-board', 'legacy'),
  sourceId: 'arduino-older-hardware-index',
  productUrl: arduinoOlderDirectory,
});

const arduinoRetired = (
  id: string,
  family: string,
  model: string,
  processorFamily = 'Not recorded in the retired-products index',
) => ({
  ...arduino(id, family, model, processorFamily, 'development-board', 'end-of-life'),
  sourceId: 'arduino-retired',
  productUrl: arduinoRetiredDirectory,
  documentationUrl: null,
});

const indexedBoard = (
  manufacturer: 'Raspberry Pi' | 'STMicroelectronics' | 'Adafruit' | 'SparkFun Electronics',
  prefix: string,
  sourceId: string,
  family: string,
  model: string,
  processorFamily: string,
  productUrl: string,
  documentationUrl: string | null = null,
) => ({
  id: `${prefix}.${model.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  manufacturer,
  sourceId,
  family,
  model,
  processorFamily,
  recordType: 'development-board' as const,
  listingStatus: 'listed' as const,
  productUrl,
  documentationUrl,
  orderableVariants: [],
  variantCoverage: 'not-reviewed' as const,
  supportLevel: 'discovery-only' as const,
});

/**
 * Manufacturer-linked board discovery snapshot checked on 2026-11-14.
 * These entries help makers find exact vendor documentation; they are not
 * circuit-ready catalog parts and intentionally contain no inferred pin maps.
 */
export const boardDirectory2026_11 = boardDirectorySchema.parse({
  schemaVersion: 1,
  directoryId: 'schemora-board-directory-2026.11',
  checkedOn: '2026-11-14',
  status: 'discovery-index',
  coverageNote:
    'Snapshot of selected models shown in official Espressif, Arduino, Raspberry Pi, STMicroelectronics, Adafruit, and SparkFun board directories on the checked date. It excludes many vendor models, third-party boards, accessories, kits, and shields/carriers. Manufacturer pages can change; a directory listing does not establish present orderability. The older Arduino index is a legacy source and does not establish present availability. Model-family entries do not enumerate every package, flash, PSRAM, antenna, header, PCB revision, or regional SKU. Every entry is discovery-only: inspect the exact board revision and official pinout before circuit use. Discovery entries cannot be added to circuit graphs or used as firmware targets.',
  sources: [
    {
      id: 'espressif',
      manufacturer: 'Espressif Systems',
      title: 'ESP DevKits — official development board directory',
      url: espDirectory,
      checkedOn: '2026-11-14',
    },
    {
      id: 'arduino',
      manufacturer: 'Arduino',
      title: 'Arduino Hardware — official current hardware directory',
      url: arduinoDirectory,
      checkedOn: '2026-11-14',
    },
    {
      id: 'arduino-older-hardware-index',
      manufacturer: 'Arduino',
      title: 'Arduino Hardware — older active-hardware family index',
      url: arduinoOlderDirectory,
      checkedOn: '2026-11-14',
    },
    {
      id: 'arduino-retired',
      manufacturer: 'Arduino',
      title: 'Arduino Legacy Documentation — retired products',
      url: arduinoRetiredDirectory,
      checkedOn: '2026-11-14',
    },
    {
      id: 'raspberry-pi-pico',
      manufacturer: 'Raspberry Pi',
      title: 'Raspberry Pi Pico series documentation',
      url: raspberryPiPicoDirectory,
      checkedOn: '2026-11-14',
    },
    {
      id: 'st-nucleo',
      manufacturer: 'STMicroelectronics',
      title: 'STMicroelectronics STM32 Nucleo board product directory',
      url: stNucleoDirectory,
      checkedOn: '2026-11-14',
    },
    {
      id: 'adafruit-board-index',
      manufacturer: 'Adafruit',
      title: 'Adafruit development board product category',
      url: adafruitDirectory,
      checkedOn: '2026-11-14',
    },
    {
      id: 'sparkfun-board-index',
      manufacturer: 'SparkFun Electronics',
      title: 'SparkFun development board product category',
      url: sparkfunDirectory,
      checkedOn: '2026-11-14',
    },
  ],
  entries: [
    esp('esp32-s31-esp-mosaico', 'ESP32-S31', 'ESP-Mosaico', 'ESP32-S31'),
    esp(
      'esp32-s31-function-coreboard-1',
      'ESP32-S31',
      'ESP32-S31-Function-CoreBoard-1',
      'ESP32-S31',
    ),
    esp('esp32-s31-korvo-1', 'ESP32-S31', 'ESP32-S31-Korvo-1', 'ESP32-S31'),
    esp(
      'esp32-s3-devkitc-1',
      'ESP32-S3',
      'ESP32-S3-DevKitC-1',
      'ESP32-S3',
      espDocs('esp32s3/esp32-s3-devkitc-1/index.html'),
    ),
    esp('esp32-s3-vocat', 'ESP32-S3', 'ESP-VoCat', 'ESP32-S3'),
    esp('esp32-s3-box-3', 'ESP32-S3', 'ESP32-S3-BOX-3', 'ESP32-S3'),
    esp('esp32-s3-box-3b', 'ESP32-S3', 'ESP32-S3-BOX-3B', 'ESP32-S3'),
    esp('esp32-s3-eye', 'ESP32-S3', 'ESP32-S3-EYE', 'ESP32-S3'),
    esp('esp32-s3-usb-otg', 'ESP32-S3', 'ESP32-S3-USB-OTG', 'ESP32-S3'),
    esp('esp32-s3-korvo-2', 'ESP32-S3', 'ESP32-S3-Korvo-2', 'ESP32-S3'),
    esp('esp32-s3-korvo-2-lcd', 'ESP32-S3', 'ESP32-S3-Korvo-2-LCD', 'ESP32-S3'),
    esp('esp32-s3-lcd-ev-board', 'ESP32-S3', 'ESP32-S3-LCD-EV-Board', 'ESP32-S3'),
    esp('esp32-s3-lcd-ev-board-2', 'ESP32-S3', 'ESP32-S3-LCD-EV-Board-2', 'ESP32-S3'),
    esp('esp32-s3-devkitm-1', 'ESP32-S3', 'ESP32-S3-DevKitM-1', 'ESP32-S3'),
    esp('esp32-s3-korvo-1', 'ESP32-S3', 'ESP32-S3-Korvo-1', 'ESP32-S3'),
    esp(
      'esp32-s2-devkitc-1',
      'ESP32-S2',
      'ESP32-S2-DevKitC-1',
      'ESP32-S2',
      espDocs('esp32s2/esp32-s2-devkitc-1/index.html'),
    ),
    esp('esp32-s2-devkitm-1', 'ESP32-S2', 'ESP32-S2-DevKitM-1', 'ESP32-S2'),
    esp('esp32-p4x-c5-function-ev-board', 'ESP32-P4', 'ESP32-P4X-C5-Function-EV-Board', 'ESP32-P4'),
    esp('esp32-p4x-eye', 'ESP32-P4', 'ESP32-P4X-EYE', 'ESP32-P4'),
    esp('esp32-p4x-function-ev-board', 'ESP32-P4', 'ESP32-P4X-Function-EV-Board', 'ESP32-P4'),
    esp(
      'esp32-c6-devkitc-1',
      'ESP32-C6',
      'ESP32-C6-DevKitC-1',
      'ESP32-C6',
      espDocs('esp32c6/esp32-c6-devkitc-1/index.html'),
    ),
    esp('esp32-c6-devkitm-1', 'ESP32-C6', 'ESP32-C6-DevKitM-1', 'ESP32-C6'),
    esp(
      'esp32-c61-devkitc-1',
      'ESP32-C61',
      'ESP32-C61-DevKitC-1',
      'ESP32-C61',
      espDocs('esp32c61/esp32-c61-devkitc-1/user_guide.html'),
    ),
    esp('esp32-c5-sensairshuttle', 'ESP32-C5', 'ESP-SensairShuttle', 'ESP32-C5'),
    esp(
      'esp32-c5-devkitc-1',
      'ESP32-C5',
      'ESP32-C5-DevKitC-1',
      'ESP32-C5',
      espDocs('esp32c5/esp32-c5-devkitc-1/index.html'),
    ),
    esp(
      'esp32-c3-devkitm-1',
      'ESP32-C3',
      'ESP32-C3-DevKitM-1',
      'ESP32-C3',
      espDocs('esp32c3/esp32-c3-devkitm-1/index.html'),
    ),
    esp(
      'esp32-c3-devkit-rust-2',
      'ESP32-C3',
      'ESP32-C3-DevKit-RUST-2',
      'ESP32-C3',
      espDocs('esp32c3/esp32-c3-devkit-rust-2/user_guide.html'),
    ),
    esp(
      'esp32-c3-aws-expresslink-devkit-2',
      'ESP32-C3',
      'ESP32-C3-AWS-ExpressLink-DevKit-2',
      'ESP32-C3',
    ),
    esp('esp32-c3-lcdkit', 'ESP32-C3', 'ESP32-C3-LCDkit', 'ESP32-C3'),
    esp('esp32-c3-lyra', 'ESP32-C3', 'ESP32-C3-Lyra', 'ESP32-C3'),
    esp('esp8684-devkitc-02', 'ESP32-C2 / ESP8684', 'ESP8684-DevKitC-02', 'ESP32-C2'),
    esp('esp8684-devkitm-1', 'ESP32-C2 / ESP8684', 'ESP8684-DevKitM-1', 'ESP32-C2'),
    esp('esp32-h4-devkitc-1', 'ESP32-H4', 'ESP32-H4-DevKitC-1', 'ESP32-H4'),
    esp('esp32-h21-devkitm-1', 'ESP32-H21', 'ESP32-H21-DevKitM-1', 'ESP32-H21'),
    esp('esp32-h2-devkitm-1', 'ESP32-H2', 'ESP32-H2-DevKitM-1', 'ESP32-H2'),
    esp(
      'esp-thread-border-router-zigbee-gateway',
      'ESP32-H2',
      'ESP Thread Border Router/Zigbee Gateway Board',
      'ESP32-S3 + ESP32-H2',
    ),
    esp(
      'esp-thread-border-router-zigbee-gateway-sub-ethernet',
      'ESP32-H2',
      'ESP Thread Border Router/Zigbee Gateway Sub-Ethernet',
      'ESP32-S3 + ESP32-H2',
    ),
    esp(
      'esp32-devkitc',
      'ESP32',
      'ESP32-DevKitC',
      'ESP32',
      espDocs('esp32/esp32-devkitc/index.html'),
    ),
    esp('esp32-devkitm-1', 'ESP32', 'ESP32-DevKitM-1', 'ESP32'),
    esp('esp32-pico-kit-1', 'ESP32', 'ESP32-PICO-KIT-1', 'ESP32'),
    esp('esp32-pico-v3-zero-devkit', 'ESP32', 'ESP32-PICO-V3-ZERO-DevKit', 'ESP32'),
    esp('esp32-pico-devkitm-2', 'ESP32', 'ESP32-PICO-DevKitM-2', 'ESP32'),
    esp('esp32-lyrat-mini', 'ESP32', 'ESP32-LyraT-Mini', 'ESP32'),
    esp('esp32-ethernet-kit', 'ESP32', 'ESP32-Ethernet-Kit', 'ESP32'),
    esp('esp32-lyratd-syna', 'ESP32', 'ESP32-LyraTD-SYNA', 'ESP32'),
    esp('esp32-vaquita-dspg', 'ESP32', 'ESP32-Vaquita-DSPG', 'ESP32'),
    arduino(
      'ventuno-q',
      'VENTUNO',
      'Arduino VENTUNO Q',
      'Qualcomm Dragonwing + STM32U5',
      'development-board',
    ),
    arduino(
      'uno-q',
      'UNO',
      'Arduino UNO Q',
      'Qualcomm Dragonwing QRB2210 + STM32U5',
      'development-board',
      'listed',
      arduinoDocs('uno-q'),
      ['2 GB RAM variant', '4 GB RAM variant'],
    ),
    arduino(
      'uno-r4-wifi',
      'UNO',
      'Arduino UNO R4 WiFi',
      'Renesas RA4M1 + ESP32-S3',
      'development-board',
      'listed',
      arduinoDocs('uno-r4-wifi'),
    ),
    arduino(
      'uno-r4-minima',
      'UNO',
      'Arduino UNO R4 Minima',
      'Renesas RA4M1',
      'development-board',
      'listed',
      arduinoDocs('uno-r4-minima'),
    ),
    arduino(
      'uno-r3',
      'UNO',
      'Arduino UNO R3',
      'ATmega328P',
      'development-board',
      'listed',
      arduinoDocs('uno-rev3'),
    ),
    arduino(
      'giga-r1-wifi',
      'GIGA',
      'Arduino GIGA R1 WiFi',
      'STM32H747XI',
      'development-board',
      'listed',
      arduinoDocs('giga-r1-wifi'),
    ),
    arduino(
      'mega-2560-rev3',
      'MEGA',
      'Arduino Mega 2560 Rev3',
      'ATmega2560',
      'development-board',
      'listed',
      arduinoDocs('mega-2560'),
    ),
    arduino(
      'nano-esp32',
      'Nano',
      'Arduino Nano ESP32',
      'ESP32-S3',
      'development-board',
      'listed',
      arduinoDocs('nano-esp32'),
    ),
    arduino(
      'nano-matter',
      'Nano',
      'Arduino Nano Matter',
      'Silicon Labs MGM240S',
      'development-board',
      'listed',
      arduinoDocs('nano-matter'),
    ),
    arduino(
      'nano-33-ble-sense-rev2',
      'Nano',
      'Arduino Nano 33 BLE Sense Rev2',
      'nRF52840',
      'development-board',
      'listed',
      arduinoDocs('nano-33-ble-sense-rev2'),
    ),
    arduino(
      'nano-33-iot',
      'Nano',
      'Arduino Nano 33 IoT',
      'SAMD21 + NINA-W102',
      'development-board',
      'listed',
      arduinoDocs('nano-33-iot'),
    ),
    arduino(
      'nano-every',
      'Nano',
      'Arduino Nano Every',
      'ATmega4809',
      'development-board',
      'listed',
      arduinoDocs('nano-every'),
    ),
    arduino(
      'nano-33-ble',
      'Nano',
      'Arduino Nano 33 BLE',
      'nRF52840',
      'development-board',
      'end-of-life',
      arduinoDocs('nano-33-ble'),
    ),
    arduino(
      'portenta-h7',
      'Portenta',
      'Arduino Portenta H7',
      'STM32H747XI',
      'system-module',
      'listed',
      arduinoDocs('portenta-h7'),
    ),
    arduino(
      'portenta-c33',
      'Portenta',
      'Arduino Portenta C33',
      'Renesas RA6M5',
      'system-module',
      'listed',
      arduinoDocs('portenta-c33'),
    ),
    arduino(
      'portenta-x8',
      'Portenta',
      'Arduino Portenta X8',
      'NXP i.MX 8M Mini',
      'system-module',
      'listed',
      arduinoDocs('portenta-x8'),
    ),
    arduino(
      'nicla-vision',
      'Nicla',
      'Arduino Nicla Vision',
      'STM32H747AII6 + Himax HM01B0',
      'development-board',
      'listed',
      arduinoDocs('nicla-vision'),
    ),
    arduino(
      'nicla-sense-me',
      'Nicla',
      'Arduino Nicla Sense ME',
      'nRF52832 + Bosch sensor suite',
      'development-board',
      'listed',
      arduinoDocs('nicla-sense-me'),
    ),
    arduino(
      'nicla-voice',
      'Nicla',
      'Arduino Nicla Voice',
      'Syntiant NDP120 + nRF52832',
      'development-board',
      'listed',
      arduinoDocs('nicla-voice'),
    ),
    arduino(
      'opta-lite',
      'Opta',
      'Arduino Opta Lite',
      'STM32H747XI',
      'industrial-controller',
      'listed',
      arduinoDocs('opta'),
      ['AFX00003'],
    ),
    arduino(
      'opta-rs485',
      'Opta',
      'Arduino Opta RS485',
      'STM32H747XI',
      'industrial-controller',
      'listed',
      arduinoDocs('opta'),
      ['AFX00001'],
    ),
    arduino(
      'opta-wifi',
      'Opta',
      'Arduino Opta WiFi',
      'STM32H747XI + ESP32',
      'industrial-controller',
      'listed',
      arduinoDocs('opta'),
      ['AFX00002'],
    ),
    arduino(
      'nano-33-ble-sense',
      'Nano',
      'Arduino Nano 33 BLE Sense (first generation)',
      'nRF52840',
      'development-board',
      'end-of-life',
      arduinoDocs('nano-33-ble-sense'),
    ),
    arduinoLegacyIndex(
      'nano-rp2040-connect',
      'Nano',
      'Arduino Nano RP2040 Connect',
      'RP2040 + u-blox NINA-W102',
    ),
    arduinoLegacyIndex('nano', 'Nano', 'Arduino Nano', 'ATmega328P'),
    arduinoLegacyIndex('mkr-1000-wifi', 'MKR', 'Arduino MKR 1000 WiFi', 'SAMD21 + WINC1500'),
    arduinoLegacyIndex('mkr-wifi-1010', 'MKR', 'Arduino MKR WiFi 1010', 'SAMD21 + NINA-W102'),
    arduinoLegacyIndex('mkr-fox-1200', 'MKR', 'Arduino MKR FOX 1200', 'SAMD21 + Sigfox module'),
    arduinoLegacyIndex('mkr-wan-1300', 'MKR', 'Arduino MKR WAN 1300', 'SAMD21 + LoRa'),
    arduinoLegacyIndex('mkr-wan-1310', 'MKR', 'Arduino MKR WAN 1310', 'SAMD21 + LoRa'),
    arduinoLegacyIndex('mkr-gsm-1400', 'MKR', 'Arduino MKR GSM 1400', 'SAMD21 + cellular modem'),
    arduinoLegacyIndex('mkr-nb-1500', 'MKR', 'Arduino MKR NB 1500', 'SAMD21 + NB-IoT modem'),
    arduinoRetired('mkr-vidor-4000', 'MKR', 'Arduino MKR Vidor 4000', 'SAMD21 + FPGA'),
    arduinoLegacyIndex('mkr-zero', 'MKR', 'Arduino MKR Zero', 'SAMD21'),
    arduinoLegacyIndex('uno-mini-limited-edition', 'UNO', 'Arduino UNO Mini Limited Edition'),
    arduinoLegacyIndex(
      'uno-wifi-rev2',
      'UNO',
      'Arduino UNO WiFi Rev2',
      'ATmega4809 + u-blox NINA-W102',
    ),
    arduinoLegacyIndex('uno-r3-smd', 'UNO', 'Arduino UNO R3 SMD', 'ATmega328P'),
    arduinoLegacyIndex('leonardo', 'Classic', 'Arduino Leonardo', 'ATmega32U4'),
    arduinoLegacyIndex('micro', 'Classic', 'Arduino Micro', 'ATmega32U4'),
    arduinoLegacyIndex('zero', 'Classic', 'Arduino Zero', 'SAMD21'),
    arduinoLegacyIndex('due', 'Mega', 'Arduino Due', 'ATSAM3X8E'),
    arduinoRetired('101', 'Retired', 'Arduino 101', 'Intel Curie'),
    arduinoRetired('bt', 'Retired', 'Arduino BT'),
    arduinoRetired('bt-v1', 'Retired', 'Arduino BT v1'),
    arduinoRetired('diecimila', 'Retired', 'Arduino Diecimila', 'ATmega168'),
    arduinoRetired('duemilanove', 'Retired', 'Arduino Duemilanove'),
    arduinoRetired('esplora', 'Retired', 'Arduino Esplora'),
    arduinoRetired('ethernet-rev3-poe', 'Retired', 'Arduino Ethernet Rev3 with PoE'),
    arduinoRetired('ethernet-rev3-no-poe', 'Retired', 'Arduino Ethernet Rev3 without PoE'),
    arduinoRetired('fio', 'Retired', 'Arduino Fio'),
    arduinoRetired('gemma', 'Retired', 'Arduino Gemma'),
    arduinoRetired('industrial-101', 'Retired', 'Arduino Industrial 101'),
    arduinoRetired('isp', 'Retired', 'Arduino ISP'),
    arduinoRetired('leonardo-eth', 'Retired', 'Arduino Leonardo ETH'),
    arduinoRetired('leonardo-eth-2-poe', 'Retired', 'Arduino Leonardo ETH 2 with PoE'),
    arduinoRetired('m0', 'Retired', 'Arduino M0'),
    arduinoRetired('m0-pro', 'Retired', 'Arduino M0 Pro'),
    arduinoRetired('mega-adk-rev3', 'Retired', 'Arduino Mega ADK Rev3'),
    arduinoRetired('mini-05', 'Retired', 'Arduino Mini 05'),
    arduinoRetired('mini-05-no-header', 'Retired', 'Arduino Mini 05 without header'),
    arduinoRetired('ng', 'Retired', 'Arduino NG'),
    arduinoRetired('primo', 'Retired', 'Arduino Primo'),
    arduinoRetired('primo-core', 'Retired', 'Arduino Primo Core'),
    arduinoRetired('pro', 'Retired', 'Arduino Pro'),
    arduinoRetired('pro-mini', 'Retired', 'Arduino Pro Mini'),
    arduinoRetired('board-serial', 'Retired', 'Arduino Board Serial'),
    arduinoRetired('board-serial-single-sided', 'Retired', 'Arduino Board Serial Single Sided'),
    arduinoRetired(
      'board-serial-single-sided-v3',
      'Retired',
      'Arduino Board Serial Single Sided v3',
    ),
    arduinoRetired('tian', 'Retired', 'Arduino Tian'),
    arduinoRetired('tre', 'Retired', 'Arduino Tre'),
    arduinoRetired('uno-rev3-long-pins', 'Retired', 'Arduino UNO Rev3 with Long Pins'),
    arduinoRetired('uno-wifi', 'Retired', 'Arduino Uno WiFi'),
    arduinoRetired('usb', 'Retired', 'Arduino USB'),
    arduinoRetired('usb-2-serial-micro', 'Retired', 'Arduino USB 2 Serial Micro'),
    arduinoRetired('yun', 'Retired', 'Arduino Yún'),
    arduinoRetired('yun-mini', 'Retired', 'Arduino Yún Mini'),
    arduinoRetired('yun-poe', 'Retired', 'Arduino Yún with PoE'),
    arduinoRetired('lily-pad-main', 'Retired', 'LilyPad Arduino Main Board'),
    arduinoRetired('lily-pad-simple', 'Retired', 'LilyPad Arduino Simple'),
    arduinoRetired('lily-pad-simplesnap', 'Retired', 'LilyPad Arduino SimpleSnap'),
    arduinoRetired('lily-pad-usb', 'Retired', 'LilyPad Arduino USB'),
    indexedBoard(
      'Raspberry Pi',
      'raspberry-pi',
      'raspberry-pi-pico',
      'Pico',
      'Raspberry Pi Pico',
      'RP2040',
      raspberryPiPicoDirectory,
    ),
    indexedBoard(
      'Raspberry Pi',
      'raspberry-pi',
      'raspberry-pi-pico',
      'Pico',
      'Raspberry Pi Pico H',
      'RP2040',
      raspberryPiPicoDirectory,
    ),
    indexedBoard(
      'Raspberry Pi',
      'raspberry-pi',
      'raspberry-pi-pico',
      'Pico W',
      'Raspberry Pi Pico W',
      'RP2040',
      raspberryPiPicoDirectory,
    ),
    indexedBoard(
      'Raspberry Pi',
      'raspberry-pi',
      'raspberry-pi-pico',
      'Pico W',
      'Raspberry Pi Pico WH',
      'RP2040',
      raspberryPiPicoDirectory,
    ),
    indexedBoard(
      'Raspberry Pi',
      'raspberry-pi',
      'raspberry-pi-pico',
      'Pico 2',
      'Raspberry Pi Pico 2',
      'RP2350',
      raspberryPiPicoDirectory,
    ),
    indexedBoard(
      'Raspberry Pi',
      'raspberry-pi',
      'raspberry-pi-pico',
      'Pico 2',
      'Raspberry Pi Pico 2 with headers',
      'RP2350',
      raspberryPiPicoDirectory,
    ),
    indexedBoard(
      'Raspberry Pi',
      'raspberry-pi',
      'raspberry-pi-pico',
      'Pico 2 W',
      'Raspberry Pi Pico 2 W',
      'RP2350',
      raspberryPiPicoDirectory,
    ),
    indexedBoard(
      'Raspberry Pi',
      'raspberry-pi',
      'raspberry-pi-pico',
      'Pico 2 W',
      'Raspberry Pi Pico 2 W with headers',
      'RP2350',
      raspberryPiPicoDirectory,
    ),
    ...[
      ['NUCLEO-U575ZI-Q', 'STM32U575ZIT6Q', 'Nucleo-144'],
      ['NUCLEO-F446RE', 'STM32F446RE', 'Nucleo-64'],
      ['NUCLEO-U5A5ZJ-Q', 'STM32U5A5ZJ', 'Nucleo-144'],
      ['NUCLEO-G491RE', 'STM32G491RE', 'Nucleo-64'],
      ['NUCLEO-H723ZG', 'STM32H723ZG', 'Nucleo-144'],
      ['NUCLEO-U545RE-Q', 'STM32U545RE', 'Nucleo-64'],
      ['NUCLEO-G431KB', 'STM32G431KB', 'Nucleo-32'],
      ['NUCLEO-L496ZG-P', 'STM32L496ZGTP', 'Nucleo-144'],
      ['NUCLEO-L152RE', 'STM32L152RE', 'Nucleo-64'],
      ['NUCLEO-F303K8', 'STM32F303K8', 'Nucleo-32'],
      ['NUCLEO-F072RB', 'STM32F072RB', 'Nucleo-64'],
      ['NUCLEO-F334R8', 'STM32F334R8', 'Nucleo-64'],
      ['NUCLEO-L432KC', 'STM32L432KC', 'Nucleo-32'],
      ['NUCLEO-F401RE', 'STM32F401RE', 'Nucleo-64'],
      ['NUCLEO-F411RE', 'STM32F411RE', 'Nucleo-64'],
      ['NUCLEO-L053R8', 'STM32L053R8', 'Nucleo-64'],
      ['NUCLEO-C071RB', 'STM32C071RB', 'Nucleo-64'],
      ['NUCLEO-H553ZG', 'STM32H553ZG', 'Nucleo-144'],
      ['NUCLEO-H7S3L8', 'STM32H7S3L8', 'Nucleo-144'],
      ['NUCLEO-C542RC', 'STM32C542RC', 'Nucleo-64'],
      ['NUCLEO-G031K8', 'STM32G031K8', 'Nucleo-32'],
      ['NUCLEO-WB55RG', 'STM32WB55RG', 'Nucleo-64'],
      ['NUCLEO-H563ZI', 'STM32H563ZI', 'Nucleo-144'],
      ['NUCLEO-WBA25CE1', 'STM32WBA25CE', 'Nucleo-64'],
      ['NUCLEO-H503RB', 'STM32H503RB', 'Nucleo-64'],
      ['NUCLEO-G474RE', 'STM32G474RE', 'Nucleo-64'],
      ['NUCLEO-H753ZI', 'STM32H753ZI', 'Nucleo-144'],
      ['NUCLEO-WBA65RI', 'STM32WBA65RI', 'Nucleo-64'],
      ['NUCLEO-N657X0-Q', 'STM32N657X0', 'Nucleo-144'],
      ['NUCLEO-L4R5ZI-P', 'STM32L4R5ZI', 'Nucleo-144'],
      ['NUCLEO-F303ZE', 'STM32F303ZE', 'Nucleo-144'],
      ['NUCLEO-G431RB', 'STM32G431RB', 'Nucleo-64'],
      ['NUCLEO-L476RG', 'STM32L476RG', 'Nucleo-64'],
      ['NUCLEO-C562RE', 'STM32C562RE', 'Nucleo-64'],
      ['NUCLEO-WL55JC', 'STM32WL55JC', 'Nucleo-64'],
      ['NUCLEO-U083RC', 'STM32U083RC', 'Nucleo-64'],
      ['NUCLEO-WB07CC', 'STM32WB07CC', 'Nucleo-64'],
      ['NUCLEO-F767ZI', 'STM32F767ZI', 'Nucleo-144'],
      ['NUCLEO-F756ZG', 'STM32F756ZG', 'Nucleo-144'],
      ['NUCLEO-F070RB', 'STM32F070RB', 'Nucleo-64'],
      ['NUCLEO-L011K4', 'STM32L011K4', 'Nucleo-32'],
    ].map(([model, mcu, family]) =>
      indexedBoard(
        'STMicroelectronics',
        'st',
        'st-nucleo',
        family!,
        model!,
        mcu!,
        stNucleoDirectory,
      ),
    ),
    ...[
      ['QT Py ESP32-S3', 'ESP32-S3'],
      ['QT Py S3', 'ESP32-S3'],
      ['ESP32-S3 Feather 8MB', 'ESP32-S3'],
      ['Feather RP2040', 'RP2040'],
      ['QT Py RP2040', 'RP2040'],
      ['ESP32-S3 Reverse TFT Feather', 'ESP32-S3'],
      ['Feather RP2040 Adalogger', 'RP2040'],
      ['QT Py ESP32-S2', 'ESP32-S2'],
      ['QT Py ESP32 Pico', 'ESP32'],
    ].map(([model, mcu]) =>
      indexedBoard(
        'Adafruit',
        'adafruit',
        'adafruit-board-index',
        'Maker board',
        `Adafruit ${model}`,
        mcu!,
        adafruitDirectory,
      ),
    ),
    ...[
      ['IoT RedBoard ESP32-P4 & ESP32-C5', 'ESP32-P4 + ESP32-C5'],
      ['ESP32-P4 PoE', 'ESP32-P4'],
      ['Thing Plus ESP32-WROOM', 'ESP32'],
      ['Thing Plus ESP32-S3', 'ESP32-S3'],
      ['RedBoard Qwiic', 'Not recorded on directory'],
      ['IoT RedBoard ESP32 MicroPython', 'ESP32'],
      ['IoT RedBoard RP2350', 'RP2350'],
      ['RedBoard Plus', 'ATmega328P'],
      ['Qwiic Pro Micro USB-C', 'ATmega32U4'],
      ['Pro nRF52840 Mini', 'nRF52840'],
      ['Thing Plus STM32', 'STM32'],
      ['RedBoard Artemis Nano', 'Artemis'],
    ].map(([model, mcu]) =>
      indexedBoard(
        'SparkFun Electronics',
        'sparkfun',
        'sparkfun-board-index',
        'Development board',
        `SparkFun ${model}`,
        mcu!,
        sparkfunDirectory,
      ),
    ),
  ],
});

export function getBoardDirectory() {
  return boardDirectorySchema.parse(boardDirectory2026_11);
}

export type BoardDirectory = z.infer<typeof boardDirectorySchema>;
