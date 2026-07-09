import { execFileSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
} from "crypto";
import { defaultSecretVaultPath } from "./paths.js";

export type SecretEntry = {
  id: string;
  label: string;
  kind?: "manual" | "ai";
  url?: string;
  username?: string;
  password?: string;
  otp?: string;
  notes?: string;
  fields?: Record<string, string>;
  updatedAt: string;
};

export type SecretMeta = {
  id: string;
  label: string;
  kind: "manual" | "ai";
  url?: string;
  username?: string;
  hasPassword: boolean;
  hasOtp: boolean;
  fields: string[];
  updatedAt: string;
};

type VaultFile = {
  version: 1;
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  data: string;
};

type OpenVault = {
  key: Buffer;
  salt: Buffer;
  entries: SecretEntry[];
};

const VAULT_PATH = process.env.MIM_SECRET_VAULT ?? defaultSecretVaultPath();
let openVault: OpenVault | null = null;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // Empty string is a valid no-passphrase vault key.
  return scryptSync(passphrase, salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

function encrypt(entries: SecretEntry[], key: Buffer, salt: Buffer): VaultFile {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify({ entries }), "utf-8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decrypt(file: VaultFile, key: Buffer): SecretEntry[] {
  if (file.version !== 1 || file.kdf !== "scrypt" || file.cipher !== "aes-256-gcm") {
    throw new Error("unsupported vault format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(file.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(file.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(file.data, "base64")),
    decipher.final(),
  ]);
  const parsed = JSON.parse(plaintext.toString("utf-8")) as { entries?: SecretEntry[] };
  return Array.isArray(parsed.entries) ? parsed.entries : [];
}

function saveOpenVault() {
  if (!openVault) throw new Error("vault locked");
  mkdirSync(dirname(VAULT_PATH), { recursive: true });
  const file = encrypt(openVault.entries, openVault.key, openVault.salt);
  writeFileSync(VAULT_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
  chmodSync(VAULT_PATH, 0o600);
}

function requireOpenVault(): OpenVault {
  if (!openVault) tryUnlockNoPassphrase();
  if (!openVault) throw new Error("secret vault locked");
  return openVault;
}

function tryUnlockNoPassphrase(): boolean {
  if (openVault) return true;
  if (!existsSync(VAULT_PATH)) return false;
  try {
    unlockSecrets("");
    return true;
  } catch {
    return false;
  }
}

function toMeta(entry: SecretEntry): SecretMeta {
  return {
    id: entry.id,
    label: entry.label,
    kind: entry.kind === "ai" ? "ai" : "manual",
    url: entry.url,
    username: entry.username,
    hasPassword: Boolean(entry.password),
    hasOtp: Boolean(entry.otp),
    fields: Object.keys(entry.fields ?? {}).sort(),
    updatedAt: entry.updatedAt,
  };
}

function findEntry(idOrLabel: string): SecretEntry {
  const query = idOrLabel.trim().toLowerCase();
  if (!query) throw new Error("missing secret id or label");
  const entry = requireOpenVault().entries.find(
    (item) => item.id === idOrLabel || item.label.toLowerCase() === query
  );
  if (!entry) throw new Error(`secret not found: ${idOrLabel}`);
  return entry;
}

function readField(entry: SecretEntry, field = "password"): string {
  const value =
    field === "label"
      ? entry.label
      : field === "url"
        ? entry.url
        : field === "username"
          ? entry.username
          : field === "password"
            ? entry.password
            : field === "otp"
              ? entry.otp
              : field === "notes"
                ? entry.notes
                : entry.fields?.[field];
  if (!value) throw new Error(`secret field not found: ${entry.label}.${field}`);
  return value;
}

export function getSecretStatus() {
  return {
    exists: existsSync(VAULT_PATH),
    unlocked: Boolean(openVault),
    count: openVault?.entries.length ?? 0,
  };
}

export function unlockSecrets(passphrase = "") {
  if (openVault) return { ok: true, created: false, ...getSecretStatus() };

  if (!existsSync(VAULT_PATH)) {
    const salt = randomBytes(16);
    const key = deriveKey(passphrase, salt);
    openVault = { key, salt, entries: [] };
    saveOpenVault();
    return { ok: true, created: true, ...getSecretStatus() };
  }

  const file = JSON.parse(readFileSync(VAULT_PATH, "utf-8")) as VaultFile;
  const salt = Buffer.from(file.salt, "base64");
  const key = deriveKey(passphrase, salt);
  try {
    openVault = { key, salt, entries: decrypt(file, key) };
  } catch {
    key.fill(0);
    throw new Error("wrong vault passphrase");
  }
  return { ok: true, created: false, ...getSecretStatus() };
}

export function lockSecrets() {
  if (openVault) openVault.key.fill(0);
  openVault = null;
  return { ok: true, ...getSecretStatus() };
}

export function listSecrets(): SecretMeta[] {
  return requireOpenVault().entries
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(toMeta);
}

export function saveSecret(input: {
  id?: string;
  label?: string;
  kind?: string;
  url?: string;
  username?: string;
  password?: string;
  otp?: string;
  notes?: string;
  fields?: Record<string, string>;
}): SecretMeta {
  const vault = requireOpenVault();
  const label = input.label?.trim();
  let entry =
    (input.id && vault.entries.find((item) => item.id === input.id)) ||
    (label && vault.entries.find((item) => item.label.toLowerCase() === label.toLowerCase()));

  if (!entry) {
    if (!label) throw new Error("missing secret label");
    entry = {
      id: randomUUID(),
      label,
      fields: {},
      updatedAt: new Date().toISOString(),
    };
    vault.entries.push(entry);
  }

  if (label) entry.label = label;
  if (input.kind === "ai" || input.kind === "manual") entry.kind = input.kind;
  for (const key of ["url", "username", "password", "otp", "notes"] as const) {
    const value = input[key];
    if (value !== undefined && value !== "") entry[key] = value;
  }

  if (input.fields) {
    entry.fields ??= {};
    for (const [key, value] of Object.entries(input.fields)) {
      const cleanKey = key.trim();
      if (cleanKey && value !== "") entry.fields[cleanKey] = value;
    }
  }

  entry.updatedAt = new Date().toISOString();
  saveOpenVault();
  return toMeta(entry);
}

export function deleteSecret(idOrLabel: string) {
  const vault = requireOpenVault();
  const entry = findEntry(idOrLabel);
  vault.entries = vault.entries.filter((item) => item.id !== entry.id);
  saveOpenVault();
  return { ok: true, deleted: entry.label };
}

export function getSecretValue(idOrLabel: string, field = "password"): string {
  return readField(findEntry(idOrLabel), field);
}

export function fillSecretField(idOrLabel: string, field = "password") {
  const entry = findEntry(idOrLabel);
  const value = readField(entry, field);
  execFileSync("atspi", ["type", value], {
    encoding: "utf-8",
    timeout: 10_000,
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" },
  });
  return { ok: true, label: entry.label, field, length: value.length };
}
