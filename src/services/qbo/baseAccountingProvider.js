class BaseAccountingProvider {
  constructor(config) {
    this.config = config;
  }

  _throwNotImplemented(methodName) {
    throw new Error(`${methodName} method must be implemented by subclass`);
  }

  async ensureChartOfAccounts(accounts) {
    this._throwNotImplemented('ensureChartOfAccounts');
  }

  async upsertJournalEntry(journalEntry) {
    this._throwNotImplemented('upsertJournalEntry');
  }

  async upsertTransfer(transfer) {
    this._throwNotImplemented('upsertTransfer');
  }

  async upsertDeposit(deposit) {
    this._throwNotImplemented('upsertDeposit');
  }

  async ensureCustomer(customer) {
    this._throwNotImplemented('ensureCustomer');
  }

  async ensureVendor(vendor) {
    this._throwNotImplemented('ensureVendor');
  }

  async attachDocument(transactionId, attachment) {
    this._throwNotImplemented('attachDocument');
  }

  async healthCheck() {
    this._throwNotImplemented('healthCheck');
  }

  async getAccount(accountId) {
    this._throwNotImplemented('getAccount');
  }

  async findAccounts(criteria) {
    this._throwNotImplemented('findAccounts');
  }

  async refreshTokens(options = {}) {
    this._throwNotImplemented('refreshTokens');
  }
}

module.exports = BaseAccountingProvider;
