/**
 * TypeScript definitions for invoke-parallel
 */

// This is very poorly typed, because TypeScript provides not nearly the
// dynamism I need in the types.

export interface CancelToken extends Promise<void> {
    resolve(): void;
}

export interface CallOptions {
    cancelToken?: PromiseLike<any>;
    keepOpen?: boolean;
}

export interface PoolOptions {
    cwd?: string;
    env?: {[key: string]: string};
    limit?: number;
    minimum?: number;
    maxPerChild?: number;
    timeout?: number;
    retries?: number;
    onError?(error: Error): any;
}

export interface ActivePoolOptions {
    cwd: string;
    env: {[key: string]: string};
    limit: number;
    minimum: number;
    maxPerChild: number;
    timeout: number;
    retries: number;
    onError(error: Error): any;
}

export interface RequireOptions {
    pool?: Pool;
    cancelToken?: PromiseLike<any>;
    isolated?: boolean;
    options?: PoolOptions; // Only meaningful with `isolated: true`
}

export interface ModuleKeys {
    [key: string]: (...args: any[]) => Promise<any>;
}

export interface ModuleCall<T extends ModuleKeys> extends T {
    (options: CallOptions): this;
}

export interface ChildStats {
    running: number;
    loaded: string[];
    dying: boolean;
    loads: number;
    calls: number;
}

export interface Pool {
    options(): ActivePoolOptions;
    childStats(): ChildStats[];

    total(): number;
    spawned(): number;
    queued(): number;
    running(): number;
    waiting(): number;
    loaded(): string[];
    cached(module: string): string[] | void;
    loading(): string[];
}

export declare function globalPool(): Pool;
export declare function pool(options?: PoolOptions): Pool;

// It's recommended to pass the `T` generic parameter to remain well-typed. This
// module can't infer it otherwise, since TypeScript provides no facilities for
// getting static modules' namespace export types at the type level.
export declare function require<T extends ModuleKeys>(module: string, options?: RequireOptions): Promise<ModuleCall<T>>;

export declare function cancelToken(init: (cancel: () => void) => any): CancelToken;
export declare class Retry extends Error {}
export declare class Cancel extends Error {}

// For the worker.
export interface SendOptions {
    keepOpen?: boolean;
}

export interface ReturnWrap {
    value: any;
    options: SendOptions;
}

export function set(value: any, options: SendOptions): ReturnWrap;
