const BTSensor = require("../BTSensor");

const requestDataCommand = [
  0xE9, 0xFC,
  0x3C, 0x4D,
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  0x10, 0x01
];

class Ultramax extends BTSensor {
  static Domain = BTSensor.SensorDomains.electrical
  static ImageFile = "TopbandBattery.webp"

  static TX_RX_SERVICE = "0000ff00-0000-1000-8000-00805f9b34fb";
  static NOTIFY_CHAR_UUID = "0000ff01-0000-1000-8000-00805f9b34fb";
  static WRITE_CHAR_UUID = "0000ff02-0000-1000-8000-00805f9b34fb";
    
  static identify(device){
    return null
  }

  async sendReadFunctionRequest(command) {
    return await this.txChar.writeValue(
      Buffer.from(command)
    );
  }

  initSchema(){
    this.debug(`${this.getName()}::initSchema`);

    super.initSchema()
    this.addDefaultParam("batteryID")

    this.addDefaultPath("voltage", "electrical.batteries.voltage").read = (
      buffer
    ) => {
      return buffer.readUInt16LE(19) / 100.0;
    };

    this.addDefaultPath("current", "electrical.batteries.current").read = (
      buffer
    ) => {
      const rawCurrent = buffer.readUInt16LE(21);
      return (rawCurrent - 0x7FFF) / 100.0;
    };
  }

  getBuffer(command) {
    return new Promise(async (resolve, reject) => {
      const r = await this.sendReadFunctionRequest(command);
      let result = Buffer.alloc(256);
      let offset = 0;
      let datasize = -1;
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(
          new Error(
            `Response timed out (+30s) from Ultramax device ${this.getName()}. `
          )
        );
      }, 30000);

      const valChanged = async (buffer) => {
        if (offset == 0) {
          //first packet
          if (buffer[0] !== 0xdd || buffer.length < 5 || buffer[1] !== command)
            reject(`Invalid buffer from ${this.getName()}, not processing.`);
          else datasize = buffer[3];
        }
        buffer.copy(result, offset);
        if (
          buffer[buffer.length - 1] == 0x41 &&
          offset + buffer.length - 7 == datasize
        ) {
          result = Uint8Array.prototype.slice.call(
            result,
            2, //changed from 0 to 2
            offset + buffer.length
          );
          this.rxChar.removeAllListeners();
          clearTimeout(timer);
          // if (!checkSum(result))
          //   reject(`Invalid checksum from ${this.getName()}, not processing.`);

          resolve(result);
        }
        offset += buffer.length;
      };
      this.rxChar.on("valuechanged", valChanged);
    });
  }

  hasGATT() {
    this.debug(`${this.getName()}::hasGATT`);
    return true;
  }

  usingGATT() {
    this.debug(`${this.getName()}::usingGATT`);
    return true;
  }

  async emitGATT() {
    this.debug(`${this.getName()}::emitGATT`);
    try {
      this.debug(`${this.getName()}::emitGATT calling getAndEmitBatteryData`);
      await this.getAndEmitBatteryData();
      this.debug(
        `${this.getName()}::emitGATT returned from getAndEmitBatteryData`
      );
    } catch (e) {
      console.error(e);
      this.debug(
        `${this.getName()}::emitGATT Failed to emit battery data for ${this.getName()}: ${e}`
      );
    }
    // }, 10000);
  }

  async initGATTConnection(isReconnecting = false) {
    this.debug(`${this.getName()}::initGATTConnection`);

    if (this.rxChar)
      try {
        this.rxChar.removeAllListeners();
      } catch (e) {
        console.error(e);
        this.debug(e);
      }

    try {
      await super.initGATTConnection(isReconnecting);
      const gattServer = await this.getGATTServer();

      this.txRxService = await gattServer.getPrimaryService(
        this.constructor.TX_RX_SERVICE
      );
      this.rxChar = await this.txRxService.getCharacteristic(
        this.constructor.NOTIFY_CHAR_UUID
      );
      this.txChar = await this.txRxService.getCharacteristic(
        this.constructor.WRITE_CHAR_UUID
      );
    } catch (e) {
      console.error(e);
      this.setError(e.message);
    }

    try {
      // FIXME not really needed?
      this.debug(`${this.getName()}::initGATTConnection sending a test poll`);
      await this.getBuffer(requestDataCommand);
    } catch (e) {
      console.error(e);
      this.debug(`Error encountered calling getBuffer(requestDataCommand)`);
    }
  }

  async getAndEmitBatteryData() {
    return this.getBuffer(requestDataCommand).then((buffer) => {
      [
        "current",
        "voltage",
      ].forEach((tag) => this.emitData(tag, buffer));
    });
  }

  async initGATTInterval() {
    this.debug(
      `${this.getName()}::initGATTInterval pollFreq=${this?.pollFreq}`
    );
    this.intervalID = setInterval(
      async () => {
        this._error = false;
        if (!(await this.device.isConnected())) {
          await this.initGATTConnection(true);
        }
        await this.emitGATT();
      },
      (this?.pollFreq ?? 40) * 1000
    );

    try {
      await this.emitGATT();
    } catch (e) {
      console.error(e);
      this.setError(e.message);
    }
  }

  async deactivateGATT(){
    await this.stopGATTNotifications(this.rxChar)
    await super.deactivateGATT()
  }
}

module.exports = Ultramax;