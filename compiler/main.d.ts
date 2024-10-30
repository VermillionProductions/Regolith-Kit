import type { UUID } from "crypto";

declare interface IRegolithSettings {
    dataPath: string;
    filterDefinitions: Record<string, string>;
    formatVersion: string;
    profiles: any[];
}

declare interface IRegolithConfig {
    author: string;
    name: string;
    packs: { behaviorPack: string; resourcePack: string };
    regolith: IRegolithSettings;
}

declare interface BPUUIDCache {
    header: UUID;
    data: UUID;
    script: UUID;
}

declare interface RPUUIDCache {
    header: UUID;
    resources: UUID;
}

declare interface IUUIDCache {
    RP: RPUUIDCache;
    BP: BPUUIDCache;
}
