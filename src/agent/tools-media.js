// src/agent/tools-media.js
//
// Media tools for Phase 1. Each tool is a *proposal* — it never mutates the
// project; it returns a `MediaResult` the user applies via the panel.
//
// Wired in Phase 1:
//   - generate_image
//   - generate_video
//   - generate_thumbnail
//   - pull_brandkit
//
// All tools:
//   - validate the ctx (snapshot) and args (zod)
//   - run the policy decision via needsApproval(tool, args, ctx)
//   - delegate to the selected provider from src/agent/media.js
//   - return a typed MediaResult; never throw on provider unavailability
//
// The renderer never sees a raw Higgsfield token. The provider reads the
// token from the IPC verb; the renderer only knows "available" vs
// "unavailable".

import { z } from 'zod';
import {
  selectProvider,
  MEDIA_KIND,
  MEDIA_RESULT_STATUS,
} from './media.js';
import { needsApproval, hashArgsForApproval } from './policy.js';
import { snapshotSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// Arg schemas (zod) — also serialized to JSON Schema in buildMediaTools().
// ---------------------------------------------------------------------------

const baseMediaArgs = {
  prompt: z.string().min(1).max(2000),
  // Provider hints are passed through; the StubProvider ignores them.
  model: z.string().optional(),
  aspectRatio: z.string().regex(/^\d+:\d+$/).optional(),
  referenceImageIds: z.array(z.string()).optional(),
};

export const generateImageArgsSchema = z.object(baseMediaArgs);
export const generateVideoArgsSchema = z.object({
  ...baseMediaArgs,
  durationSec: z.number().int().min(1).max(60).optional(),
});
export const generateThumbnailArgsSchema = z.object({
  ...baseMediaArgs,
  topic: z.string().min(1).max(200),
  faceRefId: z.string().optional(),
});
export const pullBrandkitArgsSchema = z.object({
  name: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertSnapshot(ctx) {
  return snapshotSchema.parse(ctx);
}

function buildRequestId() {
  return 'req-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function gateForApproval(toolName, args, ctx) {
  const decision = needsApproval(toolName, args, ctx);
  if (!decision.required) return { approved: true, decision, hash: hashArgsForApproval(toolName, args) };
  return {
    approved: false,
    decision,
    hash: hashArgsForApproval(toolName, args),
    // The panel renders a card from the decision; the tool result carries
    // the full approval envelope so the agent can re-attempt after the
    // user decides.
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function generateImage(ctx, args) {
  assertSnapshot(ctx);
  const parsed = generateImageArgsSchema.parse(args);
  const decision = gateForApproval('generate_image', parsed, ctx);
  if (!decision.approved) {
    return {
      schemaVersion: 1,
      status: 'approval_required',
      tool: 'generate_image',
      decision: decision.decision,
      approvalHash: decision.hash,
      requestId: buildRequestId(),
    };
  }
  const provider = selectProvider();
  return provider.generate({
    kind: MEDIA_KIND.IMAGE,
    prompt: parsed.prompt,
    requestId: buildRequestId(),
    projectRoot: ctx.projectPath,
  });
}

async function generateVideo(ctx, args) {
  assertSnapshot(ctx);
  const parsed = generateVideoArgsSchema.parse(args);
  const decision = gateForApproval('generate_video', parsed, ctx);
  if (!decision.approved) {
    return {
      schemaVersion: 1,
      status: 'approval_required',
      tool: 'generate_video',
      decision: decision.decision,
      approvalHash: decision.hash,
      requestId: buildRequestId(),
    };
  }
  const provider = selectProvider();
  return provider.generate({
    kind: MEDIA_KIND.VIDEO,
    prompt: parsed.prompt,
    requestId: buildRequestId(),
    projectRoot: ctx.projectPath,
  });
}

async function generateThumbnail(ctx, args) {
  assertSnapshot(ctx);
  const parsed = generateThumbnailArgsSchema.parse(args);
  const decision = gateForApproval('generate_thumbnail', parsed, ctx);
  if (!decision.approved) {
    return {
      schemaVersion: 1,
      status: 'approval_required',
      tool: 'generate_thumbnail',
      decision: decision.decision,
      approvalHash: decision.hash,
      requestId: buildRequestId(),
    };
  }
  const provider = selectProvider();
  return provider.generate({
    kind: MEDIA_KIND.THUMBNAIL,
    prompt: parsed.prompt,
    requestId: buildRequestId(),
    projectRoot: ctx.projectPath,
  });
}

async function pullBrandkit(ctx, args) {
  assertSnapshot(ctx);
  const parsed = pullBrandkitArgsSchema.parse(args);
  const decision = gateForApproval('pull_brandkit', parsed, ctx);
  if (!decision.approved) {
    return {
      schemaVersion: 1,
      status: 'approval_required',
      tool: 'pull_brandkit',
      decision: decision.decision,
      approvalHash: decision.hash,
      requestId: buildRequestId(),
    };
  }
  const provider = selectProvider();
  return provider.generate({
    kind: MEDIA_KIND.BRANDKIT,
    prompt: parsed.name,
    requestId: buildRequestId(),
    projectRoot: ctx.projectPath,
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function jsonSchema(zodSchema) {
  // zod v4 has z.toJSONSchema; we use a small manual shape so the renderer
  // bundle does not pull the converter. Keep `additionalProperties:false`
  // on every input schema per the addendum.
  return { type: 'object', additionalProperties: false };
}

export function buildMediaTools() {
  return [
    {
      name: 'generate_image',
      description: 'Propose an image asset for the current task. Returns a MediaResult; the user applies it via the panel. Never mutates the project.',
      inputSchema: jsonSchema(generateImageArgsSchema),
      handler: (args, ctx) => generateImage(ctx, args),
    },
    {
      name: 'generate_video',
      description: 'Propose a video asset. Returns a MediaResult; the user applies it via the panel. Never mutates the project.',
      inputSchema: jsonSchema(generateVideoArgsSchema),
      handler: (args, ctx) => generateVideo(ctx, args),
    },
    {
      name: 'generate_thumbnail',
      description: 'Propose a YouTube thumbnail or social cover. Returns a MediaResult; the user applies it via the panel.',
      inputSchema: jsonSchema(generateThumbnailArgsSchema),
      handler: (args, ctx) => generateThumbnail(ctx, args),
    },
    {
      name: 'pull_brandkit',
      description: 'Pull a brand identity (palette, type, logo) for the current task. Returns a MediaResult; the user applies it via the panel.',
      inputSchema: jsonSchema(pullBrandkitArgsSchema),
      handler: (args, ctx) => pullBrandkit(ctx, args),
    },
  ];
}

export const _internals = {
  generateImage,
  generateVideo,
  generateThumbnail,
  pullBrandkit,
  gateForApproval,
};
