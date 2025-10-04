const fs = require('fs');
const path = require('path');

class FileKeyValueStore {
    constructor({ filePath, logger = console } = {}) {
        if (!filePath) {
            throw new Error('filePath is required for FileKeyValueStore');
        }

        this.filePath = filePath;
        this.logger = logger;
        this.cache = null;
        this.initialized = false;
        this.mutex = Promise.resolve();
    }

    getFilePath() {
        return this.filePath;
    }

    async _withLock(fn) {
        const run = this.mutex.then(() => fn());
        this.mutex = run.then(() => undefined, () => undefined);
        return run;
    }

    async _ensureInitialized() {
        if (this.initialized) {
            return;
        }

        await this._withLock(async () => {
            if (this.initialized) {
                return;
            }

            await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
            this.cache = await this._readFile();
            this.initialized = true;
        });
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
        await this._ensureInitialized();
        const value = this.cache[key];
        return value === undefined ? null : this._clone(value);
    }

    async has(key) {
        await this._ensureInitialized();
        return Object.prototype.hasOwnProperty.call(this.cache, key);
    }

    async set(key, value) {
        await this._ensureInitialized();
        const toStore = this._clone(value);
        await this._withLock(async () => {
            this.cache[key] = toStore;
            await this._writeFile(this.cache);
        });
        return this._clone(toStore);
    }

    async delete(key) {
        await this._ensureInitialized();
        if (!Object.prototype.hasOwnProperty.call(this.cache, key)) {
            return false;
        }

        await this._withLock(async () => {
            delete this.cache[key];
            await this._writeFile(this.cache);
        });
        return true;
    }

    async values() {
        await this._ensureInitialized();
        return Object.values(this.cache).map(value => this._clone(value));
    }

    async entries() {
        await this._ensureInitialized();
        return Object.entries(this.cache).map(([key, value]) => [key, this._clone(value)]);
    }

    async clear() {
        await this._ensureInitialized();
        await this._withLock(async () => {
            this.cache = {};
            await this._writeFile(this.cache);
        });
    }
}

module.exports = FileKeyValueStore;
