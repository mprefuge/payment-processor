const createContext = (overrides = {}) => {
    const logs = [];
    const logFn = (...args) => {
        logs.push(args);
    };

    logFn.info = logFn;
    logFn.warn = logFn;
    logFn.error = logFn;

    const context = {
        bindingData: {},
        log: logFn,
        res: {},
        ...overrides
    };

    if (!context.bindingData) {
        context.bindingData = {};
    }

    return { context, logs };
};

module.exports = {
    createContext
};
