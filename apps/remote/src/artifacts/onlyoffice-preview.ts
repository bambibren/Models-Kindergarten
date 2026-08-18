import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ArtifactRecord, PptxPlaybackResponse } from "@kindergarten/contracts";
import { ApiProblemError } from "../server/api-problem.js";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

interface PreviewTicket {
  artifactId: string;
  ownerId: string;
  sha256: string;
  purpose: "onlyoffice-preview";
  exp: number;
}

export interface OnlyOfficePreviewOptions {
  documentServerPublicUrl?: string;
  artifactInternalBaseUrl?: string;
  documentServerJwtSecret?: string;
  ticketSigningSecret?: string;
  ticketTtlSeconds?: number;
  now?: () => number;
}

export class OnlyOfficePreviewService {
  private readonly publicUrl: string;
  private readonly artifactBaseUrl: string;
  private readonly documentServerJwtSecret: string | undefined;
  private readonly ticketSecret: string;
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  constructor(options: OnlyOfficePreviewOptions = {}) {
    this.publicUrl = baseUrl(options.documentServerPublicUrl ?? process.env.ONLYOFFICE_PUBLIC_URL ?? "http://127.0.0.1:8080");
    this.artifactBaseUrl = baseUrl(options.artifactInternalBaseUrl ?? process.env.ONLYOFFICE_ARTIFACT_BASE_URL ?? "http://host.docker.internal:7331/api/control/v1");
    this.documentServerJwtSecret = nonEmpty(options.documentServerJwtSecret ?? process.env.ONLYOFFICE_JWT_SECRET);
    this.ticketSecret = nonEmpty(options.ticketSigningSecret ?? process.env.ONLYOFFICE_PREVIEW_SECRET) ?? randomBytes(32).toString("base64url");
    this.ttlSeconds = options.ticketTtlSeconds ?? 5 * 60;
    this.now = options.now ?? (() => Date.now());
  }

  create(artifact: ArtifactRecord): PptxPlaybackResponse {
    if (!isPptx(artifact)) {
      throw new ApiProblemError(409, "VALIDATION_FAILED", "只有 PPTX Artifact 支持动画播放", false);
    }
    const ticket = signJwt({
      artifactId: artifact.artifactId,
      ownerId: artifact.ownerId,
      sha256: artifact.primary.sha256,
      purpose: "onlyoffice-preview",
      exp: Math.floor(this.now() / 1000) + this.ttlSeconds,
    } satisfies PreviewTicket, this.ticketSecret);
    const config: PptxPlaybackResponse["config"] = {
      type: "embedded",
      documentType: "slide",
      document: {
        fileType: "pptx",
        key: playbackKey(artifact),
        title: artifact.displayName.toLowerCase().endsWith(".pptx") ? artifact.displayName : `${artifact.displayName}.pptx`,
        url: `${this.artifactBaseUrl}/onlyoffice/artifacts/${encodeURIComponent(artifact.artifactId)}/raw?token=${encodeURIComponent(ticket)}`,
        permissions: { download: false, edit: false, print: false },
      },
      editorConfig: {
        lang: "zh-CN",
        mode: "view",
        customization: {
          compactHeader: true,
          hideRightMenu: true,
          toolbarHideFileName: true,
        },
        embedded: { autostart: "player", toolbarDocked: "bottom" },
      },
    };
    return {
      documentServerApiUrl: `${this.publicUrl}/web-apps/apps/api/documents/api.js`,
      config: this.documentServerJwtSecret
        ? { ...config, token: signJwt(config, this.documentServerJwtSecret) }
        : config,
    };
  }

  verify(artifactId: string, token: string | null): PreviewTicket {
    const payload = verifyJwt(token, this.ticketSecret);
    if (!isPreviewTicket(payload) || payload.artifactId !== artifactId || payload.exp <= Math.floor(this.now() / 1000)) {
      throw forbidden();
    }
    return payload;
  }
}

function isPptx(artifact: ArtifactRecord): boolean {
  return artifact.kind === "file" && (
    artifact.primary.mimeType === PPTX_MIME || artifact.displayName.toLowerCase().endsWith(".pptx")
  );
}

function playbackKey(artifact: ArtifactRecord): string {
  return `${artifact.artifactId.slice(-24)}-${artifact.primary.sha256.slice(0, 24)}`;
}

function signJwt(payload: object, secret: string): string {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const body = encode(payload);
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function verifyJwt(token: string | null, secret: string): unknown {
  if (!token) throw forbidden();
  const parts = token.split(".");
  if (parts.length !== 3) throw forbidden();
  const [header, body, signature] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${header}.${body}`).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); }
  catch { throw forbidden(); }
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) throw forbidden();
  try {
    const parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsedHeader.alg !== "HS256" || parsedHeader.typ !== "JWT") throw forbidden();
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof ApiProblemError) throw error;
    throw forbidden();
  }
}

function isPreviewTicket(value: unknown): value is PreviewTicket {
  if (!value || typeof value !== "object") return false;
  const ticket = value as Record<string, unknown>;
  return typeof ticket.artifactId === "string" && typeof ticket.ownerId === "string" &&
    typeof ticket.sha256 === "string" && ticket.purpose === "onlyoffice-preview" &&
    typeof ticket.exp === "number" && Number.isSafeInteger(ticket.exp);
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function baseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("ONLYOFFICE URL 必须使用 HTTP(S)");
  return url.toString().replace(/\/$/, "");
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function forbidden(): ApiProblemError {
  return new ApiProblemError(404, "ARTIFACT_FORBIDDEN", "PPTX 播放票据无效或已过期", false);
}
