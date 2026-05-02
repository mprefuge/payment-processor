const rootLogger = console;
const fs = require('fs');
const path = require('path');

class FileKeyValueStore {
  constructor({ filePath, logger = rootLogger } = {}) {
    if (!filePath) {
      throw new Error('filePath is required for FileKeyValueStore');
    }

    this.filePath = filePath;
    this.logger = logger;
    this.mutex = Promise.resolve();
  }

  getFilePath() {
    return this.filePath;
  }

  async _withLock(fn) {
    const run = this.mutex.then(() => fn());
    this.mutex = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async _ensureDirectory() {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  async _readFile() {
    try {
      const content = await fs.promises.readFile(this.filePath, 'utf8');
      if (!content) {
        return {};
      }
      return JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  async _writeFile(data) {
    const serialized = JSON.stringify(data, null, 2);
    await fs.promises.writeFile(this.filePath, serialized, 'utf8');
  }

  _clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  async get(key) {
    await this._ensureDirectory();
    const cache = await this._readFile();
    const value = cache[key];
    return value === undefined ? null : this._clone(value);
  }

  async has(key) {
    await this._ensureDirectory();
    const cache = await this._readFile();
    return Object.prototype.hasOwnProperty.call(cache, key);
  }

  async set(key, value) {
    await this._ensureDirectory();
    const toStore = this._clone(value);
    await this._withLock(async () => {
      const cache = await this._readFile();
      cache[key] = toStore;
      await this._writeFile(cache);
    });
    return this._clone(toStore);
  }

  async delete(key) {
    await this._ensureDirectory();

    let deleted = false;

    await this._withLock(async () => {
      const cache = await this._readFile();
      if (!Object.prototype.hasOwnProperty.call(cache, key)) {
        return;
      }

      delete cache[key];
      await this._writeFile(cache);
      deleted = true;
    });

    return deleted;
  }

  async values() {
    await this._ensureDirectory();
    const cache = await this._readFile();
    return Object.values(cache).map((value) => this._clone(value));
  }

  async entries() {
    await this._ensureDirectory();
    const cache = await this._readFile();
    return Object.entries(cache).map(([key, value]) => [key, this._clone(value)]);
  }

  async clear() {
    await this._ensureDirectory();
    await this._withLock(async () => {
      await this._writeFile({});
    });
  }
}

module.exports = FileKeyValueStore;
