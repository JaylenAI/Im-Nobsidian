import { z } from "zod";

export const ConfigSchema = z.object({
  version: z.literal(1),
  notion: z.object({
    token: z.string().startsWith("ntn_"),
    rootPageId: z.string(),
    workspaceId: z.string().optional(),
    parentMode: z.enum(["page", "database"]).default("page"),
    databaseId: z.string().optional(),
  }),
  sync: z.object({
    direction: z.enum(["push", "pull", "both"]).default("both"),
    conflictStrategy: z
      .enum(["local-first", "remote-first", "manual", "duplicate"])
      .default("manual"),
    autoSync: z.boolean().default(false),
    autoSyncInterval: z.number().min(30).max(3600).default(300),
    deleteSync: z.boolean().default(false),
    syncFiles: z.boolean().default(true),
  }),
  paths: z.object({
    include: z.array(z.string()).default(["**/*"]),
    exclude: z.array(z.string()).default([]),
    attachments: z.string().default("attachments"),
  }),
  conversion: z.object({
    preferMarkdownApi: z.boolean().default(true),
    preserveMarkers: z.boolean().default(true),
    frontmatterMapping: z.boolean().default(true),
    imageDownload: z.enum(["immediate", "lazy", "skip"]).default("immediate"),
  }),
  advanced: z.object({
    concurrency: z.number().min(1).max(10).default(3),
    maxRetries: z.number().min(0).max(10).default(5),
    timeoutMs: z.number().min(5000).max(60000).default(30000),
    batchSize: z.number().min(1).max(100).default(50),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = {
  version: 1,
  notion: {
    token: "",
    rootPageId: "",
    parentMode: "page",
  },
  sync: {
    direction: "both",
    conflictStrategy: "manual",
    autoSync: false,
    autoSyncInterval: 300,
    deleteSync: false,
    syncFiles: true,
  },
  paths: {
    include: ["**/*"],
    exclude: [],
    attachments: "attachments",
  },
  conversion: {
    preferMarkdownApi: true,
    preserveMarkers: true,
    frontmatterMapping: true,
    imageDownload: "immediate",
  },
  advanced: {
    concurrency: 3,
    maxRetries: 5,
    timeoutMs: 30000,
    batchSize: 50,
  },
};
