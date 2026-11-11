import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { open, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAGIC = Buffer.from('EBAYMCP1');
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface TokenRecord {
  refreshToken: string;
  updatedAt: string;
  refreshTokenExpiresAt?: string;
}

export interface TokenStoreStatus {
  source: 'file' | 'memory' | 'env' | 'none';
  readable: boolean;
}

interface KeyCache {
  secret: string;
  salt: Buffer;
  key: Buffer;
}

export class TokenStore {
  private cache: TokenRecord | null = null;
  /** Refresh token captured in this process. Used when the file is gone, which is the Render free-plan case after a restart only if this is still the same process. */
  private held: TokenRecord | null = null;
  private cachedMtime = 0;
  private keyCache: KeyCache | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly encryptionKey: string | undefined,
    private readonly envRefreshToken: string | undefined,
  ) {}

  cachedRefreshToken(): string | undefined {
    return this.cache?.refreshToken ?? this.envRefreshToken;
  }

  async status(): Promise<TokenStoreStatus> {
    try {
      const info = await stat(this.filePath);
      if (!info.isFile()) return this.heldOrEnvStatus();
      if (!this.encryptionKey) return { source: 'file', readable: false };
      await this.readFileRecord();
      return { source: 'file', readable: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return this.heldOrEnvStatus();
      return { source: 'file', readable: false };
    }
  }

  private heldOrEnvStatus(): TokenStoreStatus {
    if (this.held) return { source: 'memory', readable: true };
    return this.envStatus();
  }

  async getRefreshToken(): Promise<string | null> {
    const record = await this.load();
    return record?.refreshToken ?? null;
  }

  async save(record: TokenRecord): Promise<'file' | 'memory'> {
    this.held = record;
    this.cache = record;
    if (!this.encryptionKey) return 'memory';
    await this.enqueue(async () => {
      const payload = this.encrypt(JSON.stringify(record));
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tempPath, payload, { mode: 0o600 });
      await rename(tempPath, this.filePath);
      this.held = record;
      this.cache = record;
      const info = await stat(this.filePath);
      this.cachedMtime = info.mtimeMs;
    });
    return 'file';
  }

  private envStatus(): TokenStoreStatus {
    if (this.envRefreshToken) return { source: 'env', readable: true };
    return { source: 'none', readable: false };
  }

  private async load(): Promise<TokenRecord | null> {
    return this.enqueue(async () => {
      try {
        const info = await stat(this.filePath);
        if (!info.isFile()) return this.memoryOrEnv();
        if (this.cache && info.mtimeMs === this.cachedMtime) return this.cache;
        const record = await this.readFileRecord();
        this.cache = record;
        this.held = record;
        this.cachedMtime = info.mtimeMs;
        return record;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return this.memoryOrEnv();
        throw error;
      }
    });
  }

  private memoryOrEnv(): TokenRecord | null {
    if (this.held) return this.held;
    return this.envRecord();
  }

  private envRecord(): TokenRecord | null {
    if (!this.envRefreshToken) return null;
    return { refreshToken: this.envRefreshToken, updatedAt: 'env' };
  }

  private async readFileRecord(): Promise<TokenRecord> {
    if (!this.encryptionKey) {
      throw new Error('A token file exists but TOKEN_ENCRYPTION_KEY is not set.');
    }
    const bytes = await readFile(this.filePath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.decrypt(bytes));
    } catch {
      throw new Error('The token store could not be decrypted with TOKEN_ENCRYPTION_KEY.');
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as TokenRecord).refreshToken !== 'string') {
      throw new Error('The token store did not contain a refresh token.');
    }
    return parsed as TokenRecord;
  }

  private encrypt(plaintext: string): Buffer {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.keyFor(salt), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, salt, iv, tag, ciphertext]);
  }

  private decrypt(payload: Buffer): string {
    if (payload.length < MAGIC.length + SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 1) {
      throw new Error('short');
    }
    if (!payload.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('magic');
    }
    let offset = MAGIC.length;
    const salt = payload.subarray(offset, offset + SALT_LENGTH);
    offset += SALT_LENGTH;
    const iv = payload.subarray(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;
    const tag = payload.subarray(offset, offset + TAG_LENGTH);
    offset += TAG_LENGTH;
    const ciphertext = payload.subarray(offset);
    const decipher = createDecipheriv('aes-256-gcm', this.keyFor(salt), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  private keyFor(salt: Buffer): Buffer {
    if (!this.encryptionKey) throw new Error('TOKEN_ENCRYPTION_KEY is not set.');
    if (this.keyCache && this.keyCache.secret === this.encryptionKey && this.keyCache.salt.equals(salt)) {
      return this.keyCache.key;
    }
    const key = scryptSync(this.encryptionKey, salt, 32);
    this.keyCache = { secret: this.encryptionKey, salt: Buffer.from(salt), key };
    return key;
  }

  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => this.withFileLock(fn));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const handle = await open(lockPath, 'wx');
        await handle.close();
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > 30_000) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) throw new Error('Timed out waiting for the token store lock.');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await fn();
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }
  }
}
