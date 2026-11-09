declare module 'node:fs' { export const existsSync: any; export const readFileSync: any; }
declare module 'node:path' { export const resolve: any; export const dirname: any; export const join: any; }
declare module 'node:child_process' { export const spawnSync: any; }
declare const process: any;
