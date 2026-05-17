export interface CompatibilityProfile {
  name: string;
  gitVersion: string;
  protocolVersion: 0 | 2;
  allowFilter: boolean;
  allowAnySHA1InWant: boolean;
  httpReceivePack: boolean;
  expectFilter: boolean;
  expectShallow: boolean;
  imageTag: string;
}

export const compatibilityProfiles: CompatibilityProfile[] = [
  {
    name: "launchpad-turnip",
    gitVersion: "2.25.1",
    protocolVersion: 0,
    allowFilter: false,
    allowAnySHA1InWant: false,
    httpReceivePack: false,
    expectFilter: false,
    expectShallow: true,
    imageTag: "git-server-launchpad-turnip",
  },
  {
    name: "github",
    gitVersion: "2.43.x",
    protocolVersion: 2,
    allowFilter: true,
    allowAnySHA1InWant: true,
    httpReceivePack: false,
    expectFilter: true,
    expectShallow: true,
    imageTag: "git-server-github",
  },
  {
    name: "gitlab",
    gitVersion: "2.34.x",
    protocolVersion: 2,
    allowFilter: true,
    allowAnySHA1InWant: true,
    httpReceivePack: false,
    expectFilter: true,
    expectShallow: true,
    imageTag: "git-server-gitlab",
  },
  {
    name: "forgejo",
    gitVersion: "2.45.x",
    protocolVersion: 2,
    allowFilter: true,
    allowAnySHA1InWant: false,
    httpReceivePack: false,
    expectFilter: true,
    expectShallow: true,
    imageTag: "git-server-forgejo",
  },
];
