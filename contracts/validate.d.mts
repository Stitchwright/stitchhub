/* eslint-disable @typescript-eslint/no-explicit-any -- examples and schemas are arbitrary JSON documents */
export function check(schema: string | Record<string, unknown>, value: unknown, file?: string, at?: string, root?: Record<string, unknown> | null): string[];
export function loadSchema(name: string): Record<string, any>;
export function loadExample(name: string): Record<string, any>;
