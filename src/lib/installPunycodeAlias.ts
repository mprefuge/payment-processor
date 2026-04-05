const moduleLoader = require('module') as typeof import('module');

type ModuleWithLoad = typeof import('module') & {
  _load?: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

export const installPunycodeAlias = (): void => {
  const moduleAny = moduleLoader as ModuleWithLoad;

  if (typeof moduleAny._load !== 'function') {
    return;
  }

  const currentLoad = moduleAny._load;

  if ((currentLoad as { __punycodeAliasInstalled?: boolean }).__punycodeAliasInstalled) {
    return;
  }

  const aliasingLoad = ((request: string, parent: NodeModule | null, isMain: boolean) => {
    if (request === 'punycode') {
      return currentLoad.call(moduleAny, 'punycode/', parent, isMain);
    }

    return currentLoad.call(moduleAny, request, parent, isMain);
  }) as typeof currentLoad & { __punycodeAliasInstalled?: boolean };

  aliasingLoad.__punycodeAliasInstalled = true;
  moduleAny._load = aliasingLoad;
};
