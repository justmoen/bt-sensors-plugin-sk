const BTSensor = require("../BTSensor");

const testData=[
  ['3a 30 31 35 34 30 31 30 30 45 43 30 30 30 31 30 32 30 33 30',
  '34 30 35 30 36 30 44 35 42 30 44 37 38 30 44 37 39 30 44 37',
  '39 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30',
  '30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30',
  '30 30 30 30 30 30 30 30 30 46 30 30 30 30 30 30 30 34 36 34',
  '36 34 36 34 36 31 30 45 45 30 30 30 30 30 30 30 30 37 46 46',
  '46 46 46 46 46 33 35 43 35 30 30 31 45 30 34 30 30 42 34 36',
  '33 30 30 30 31 44 34 43 30 30 30 30 34 35 38 46 45 30 30 30',
  '31 44 34 43 30 30 30 30 32 30 35 46 30 30 30 30 36 30 30 30',
  '31 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30',
  '30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30',
  '30 30 30 30 30 30 30 30 30 30 30 30 30 37 39 00 7e 00 00 00']
]

class Ultramax extends BTSensor {
  static Domain = BTSensor.SensorDomains.electrical
  static ImageFile = "TopbandBattery.webp"

  static TX_RX_SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb";
  static NOTIFY_CHAR_UUID = "0000fff1-0000-1000-8000-00805f9b34fb";
  static WRITE_CHAR_UUID = "0000fff6-0000-1000-8000-00805f9b34fb";

  static identify(device){
    return null
  }

  async sendReadFunctionRequest(command) {
    return await this.txChar.writeValueWithoutResponse(command);
  }

  buildPollCommand() {
    const payload = Buffer.from([0x01, 0x54, 0x00, 0x00]);

    let sum = 0;
    for (const b of payload)
      sum += b;

    sum &= 0xFF;

    return Buffer.from(
      ':' +
      payload.toString('hex').toUpperCase() +
      sum.toString(16).padStart(2, '0').toUpperCase() +
      '~',
      'ascii'
    );
  }

  verifyChecksum(buffer) {
    if (buffer.length < 2) {
      console.log(
        `Cannot checksum ${buffer}. Invalid buffer. Buffer must be at least 2 bytes long.`
      );
      return false;
    }
      
    const data = buffer.slice(0, buffer.length - 1);
    const received = buffer[buffer.length - 1];

    let sum = 0;
    for (const b of data)
      sum += b;

    sum &= 0xFF;

    return sum === received;
  }

  initSchema(){
    this.debug(`${this.getName()}::initSchema`);

    super.initSchema();
    this.numberOfCells = 4;
    this.addDefaultParam("batteryID");
    this.addParameter(
      "numberOfCells",
      {
          title:'number of cells in battery',
          type: 'integer',
          default: this.numberOfCells,
          isRequired: true
      }
    );

    this.addDefaultPath('voltage','electrical.batteries.voltage')
      .read=
      (buffer)=>{return buffer.readUInt16BE(50) / 1000}

    this.addDefaultPath('current','electrical.batteries.current')
      .read=
      (buffer)=>{return buffer.readInt32BE(46) / 100}

    this.addDefaultPath("cycles", "electrical.batteries.cycles").read = (
      buffer
    ) => {
      return buffer.readUInt16BE(55);
    };

    for (let i = 0; i < this.numberOfCells; i++) {
      this.addMetadatum(
        `cell${i}Voltage`,
        "V",
        `Cell ${i + 1} voltage`,
        (buffer) => {
          return buffer.readUInt16BE(i * 2) / 1000;
        }
      ).default = `electrical.batteries.{batteryID}.cell${i}.voltage`;
    }

    this.addMetadatum('temp', 'C', 'Temperature reading',
      (buffer)=>{
        return buffer.readUInt16BE(52)/10
      }
    ).default='electrical.batteries.{batteryID}.temperature'
  }

  getBuffer(command) {
    return new Promise(async (resolve, reject) => {
      const r = await this.sendReadFunctionRequest(command);
      let result = Buffer.alloc(256);
      let offset = 0;
      
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(
          new Error(
            `Response timed out (+30s) from Ultramax device ${this.getName()}. `
          )
        );
      }, 30000);

      const valChanged = async (buffer) => {
        buffer.copy(result, offset);
        const start = result.indexOf(':');
        const end = result.indexOf('~');
        if (
          start !== -1 &&
          end !== -1 &&
          end >= start
          // buffer.substring(start + 1).readUInt8(1) == 0x54
        ) {
          result = Uint8Array.prototype.slice.call(
            result,
            start + 1,
            end
          );
          buffer = Uint8Array.prototype.slice.call(
            buffer,
            end + 1
          );
          this.rxChar.removeAllListeners();
          clearTimeout(timer);
          // if (!this.verifyChecksum(result))
          //   reject(`Invalid checksum from ${this.getName()}, not processing.`);
          const buf = Buffer.from(result.replace(/\s+/g, ''), 'hex');
          resolve(buf.toString('ascii').substring(25));
        }
        offset += buffer.length;
      };
      this.rxChar.on("valuechanged", valChanged);
    });
  }

  hasGATT() {
    // this.debug(`${this.getName()}::hasGATT`);
    return true;
  }

  usingGATT() {
    // this.debug(`${this.getName()}::usingGATT`);
    return true;
  }

  async emitGATT() {
    // this.debug(`${this.getName()}::emitGATT`);
    try {
      // this.debug(`${this.getName()}::emitGATT calling getAndEmitBatteryData`);
      await this.getAndEmitBatteryData();
      // this.debug(
      //   `${this.getName()}::emitGATT returned from getAndEmitBatteryData`
      // );
    } catch (e) {
      console.error(e);
      this.debug(
        `${this.getName()}::emitGATT Failed to emit battery data for ${this.getName()}: ${e}`
      );
    }
  }

  async initGATTConnection(isReconnecting = false) {
    // this.debug(`${this.getName()}::initGATTConnection`);

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
      await this.rxChar.startNotifications();
    } catch (e) {
      console.error(e);
      this.setError(e.message);
    }

    try {
      // FIXME not really needed?
      await this.getBuffer(this.buildPollCommand());
    } catch (e) {
      console.error(e);
      this.debug(`Error encountered calling getBuffer(this.buildPollCommand())`);
    }
  }

  async getAndEmitBatteryData() {
    return this.getBuffer(this.buildPollCommand()).then((result) => {
      [
        "current",
        "voltage",
        "cycles",
        "temp",
      ].forEach((tag) => this.emitData(tag, result));
      for (let i = 0; i < this.numberOfCells; i++) {
        this.emitData(`cell${i}Voltage`, result);
      }
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

  async initGATTNotifications() {
    this.debug(`${this.getName()}::initGATTNotifications`);
  }

  async deactivateGATT(){
    await this.stopGATTNotifications(this.rxChar)
    await super.deactivateGATT()
  }
}

module.exports = Ultramax;