const BTSensor = require("../BTSensor");

class Ultramax extends BTSensor {
  static Domain = BTSensor.SensorDomains.electrical
  static ImageFile = "TopbandBattery.webp"

  static TX_RX_SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb";
  static NOTIFY_CHAR_UUID = "0000fff1-0000-1000-8000-00805f9b34fb";
  static WRITE_CHAR_UUID = "0000fff6-0000-1000-8000-00805f9b34fb";

  constructor() {
    super();
    this.rxBuffer = '';
  }
    
  static identify(device){
    return null
  }

  async sendReadFunctionRequest(command) {
    this.debug(`${this.getName()}::sendReadFunctionRequest poll command ${command}`)
    return await this.txChar.writeValue(command);
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
    this.addDefaultParam("batteryID");
    this.addParameter(
      "numberOfCells",
      {
          title:'number of cells in battery',
          type: 'integer',
          default: 4,
          isRequired: true
      }
    );

    this.addDefaultPath('voltage','electrical.batteries.voltage')
      .read=
      (result)=>{return result}

    this.addDefaultPath('current','electrical.batteries.current')
      .read=
      (result)=>{return result.readInt32B(7) / 100} 
  }

  handleNotification(data) {
    this.rxBuffer += data.toString('ascii');

    while (true) {
      const start = this.rxBuffer.indexOf(':');
      const end = this.rxBuffer.indexOf('~');

      if (start === -1 || end === -1 || end <= start)
        break;

      const frame = this.rxBuffer.substring(start + 1, end);
      this.rxBuffer = this.rxBuffer.substring(end + 1);

      this.processFrame(frame);
    }
  }

  processFrame(frameHex) {
    const raw = Buffer.from(frameHex, 'hex');

    if (!this.verifyChecksum(raw))
      return;

    if (raw.readUInt8(1) !== 0x54)
      return;

    const result = {};

    result.stateOfCharge = raw.readUInt8(4);
    result.voltage = raw.readUInt16BE(5) / 1000;
    result.current = raw.readInt32BE(7) / 100;
    result.temperature = raw.readUInt16BE(11) / 10;
    result.cycles = raw.readUInt16BE(13);

    const protection = raw.readUInt16BE(15);

    result.alarms = {
      highVoltage: !!(protection & (1 << 0)),
      lowVoltage: !!(protection & (1 << 1)),
      overCurrentCharging: !!(protection & (1 << 2)),
      overCurrentDischarging: !!(protection & (1 << 3)),
      lowTempCharging: !!(protection & (1 << 4)),
      lowTempDischarging: !!(protection & (1 << 5)),
      highTempCharging: !!(protection & (1 << 6)),
      highTempDischarging: !!(protection & (1 << 7)),
      shortCircuit: !!(protection & (1 << 8))
    };

    result.cells = [];

    let offset = 17;
    while (offset + 1 < raw.length) {

      const mv = raw.readUInt16BE(offset);

      if (mv === 0 || mv > 5000)
        break;

      result.cells.push(mv / 1000);
      offset += 2;

      if (result.cells.length >= 16)
        break;
    }

    return result;
  }

  getBuffer(command) {
    return new Promise(async (resolve, reject) => {
      const r = await this.sendReadFunctionRequest(command);
      let result = Buffer.alloc(256);

      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(
          new Error(
            `Response timed out (+30s) from Ultramax device ${this.getName()}. `
          )
        );
      }, 30000);

      this.rxChar.on("valuechanged", buffer => {
        result = this.handleNotification(Buffer.from(buffer));
        this.rxChar.removeAllListeners();
        clearTimeout(timer);
        resolve(result);
      });
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
      ].forEach((tag) => this.emitData(tag, result));
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