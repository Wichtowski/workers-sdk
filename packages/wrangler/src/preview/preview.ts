import {
	getPreviewBaseConfig,
	extractConfigBindings,
	isWorkerNotFoundError,
	preview,
	resolveWorkerName,
} from "@cloudflare/deploy-helpers";
import {
	experimental_patchConfig,
	formatConfigSnippet,
	getBindingTypeFriendlyName,
	getWranglerTmpDir,
	isNonInteractiveOrCI,
	PatchConfigError,
	UserError,
	mapWorkerMetadataBindings,
	PREVIEW_BINDING_CONFIG_FIELDS,
} from "@cloudflare/workers-utils";
import { getAssetsOptions } from "../assets";
import { getNormalizedContainerOptions } from "../containers/config";
import { createCommand } from "../core/create-command";
import { getEntry } from "../deployment-bundle/entry";
import { buildWorker } from "../deployment-bundle/maybe-build-worker";
import { cleanupDestination } from "../deployment-bundle/merge-config-args";
import { confirm } from "../dialogs";
import { writeOutput } from "../output";
import { requireAuth } from "../user";
import { deployPreviewContainers, verifyContainersScope } from "./containers";
import type { PreviewBaseConfig } from "@cloudflare/deploy-helpers";
import type {
	Config,
	PreviewsConfig,
	WorkerMetadataBinding,
} from "@cloudflare/workers-utils";

function configFromPreviewBaseConfig({
	env,
	tail_consumers,
	...baseConfig
}: PreviewBaseConfig): PreviewsConfig {
	const bindings = mapWorkerMetadataBindings(
		Object.entries(env ?? {}).map(([name, binding]) => ({
			name,
			...binding,
		})) as unknown as WorkerMetadataBinding[]
	);

	return {
		...baseConfig,
		...bindings,
		...(tail_consumers && {
			tail_consumers: tail_consumers.map(({ name }) => ({ service: name })),
		}),
	};
}

const REPLACE_ME = "<REPLACE_ME>";

function isConfigured(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	if (value !== null && typeof value === "object") {
		return Object.values(value).some(isConfigured);
	}
	return value !== undefined;
}

function formatList(items: string[]): string {
	if (items.length <= 1) {
		return items[0] ?? "";
	}
	if (items.length === 2) {
		return items.join(" and ");
	}
	return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function getProductionBindings(config: Config) {
	return extractConfigBindings({
		...config,
		assets: undefined,
		previews: config,
	});
}

function getProductionResourceWarning(
	productionBindings: ReturnType<typeof getProductionBindings>
): string {
	const bindingTypes = [
		...new Set(
			Object.values(productionBindings).map(({ type }) =>
				getBindingTypeFriendlyName(
					type as Parameters<typeof getBindingTypeFriendlyName>[0]
				)
			)
		),
	];
	if (bindingTypes.length === 0) {
		return "";
	}
	return `\n\nDo not reuse production binding configuration for ${formatList(bindingTypes)} unless you intentionally want Preview traffic to share production resources.`;
}

function replaceProductionConfigValues(value: unknown, key?: string): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => replaceProductionConfigValues(item));
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([nestedKey, nestedValue]) => [
				nestedKey,
				replaceProductionConfigValues(nestedValue, nestedKey),
			])
		);
	}
	if (key === "binding" || key === "name" || key === "type") {
		return value;
	}
	return REPLACE_ME;
}

function getPreviewConfigFromProductionBindings(
	config: Config,
	productionBindings: ReturnType<typeof getProductionBindings>
): PreviewsConfig {
	if (Object.keys(productionBindings).length === 0) {
		return {};
	}
	return Object.fromEntries(
		PREVIEW_BINDING_CONFIG_FIELDS.filter((field) =>
			isConfigured(config[field])
		).map((field) => [field, replaceProductionConfigValues(config[field])])
	) as PreviewsConfig;
}

function missingPreviewsConfigError(
	previews: PreviewsConfig,
	configPath: Config["configPath"],
	detail = ""
): UserError {
	const snippet = formatConfigSnippet({ previews }, configPath);
	return new UserError(
		`Your Wrangler configuration is missing a \`previews\` block. Add the following to your configuration file:\n\n${snippet}${detail}`,
		{ telemetryMessage: "preview command previews configuration missing" }
	);
}

async function ensurePreviewsConfig(
	accountId: string,
	args: {
		workerName?: string;
		"worker-name"?: string;
		ignoreBaseConfig?: boolean;
	},
	config: Config
): Promise<Config> {
	if (config.previews !== undefined) {
		return config;
	}

	const configPath = config.userConfigPath ?? config.configPath;
	const productionBindings = getProductionBindings(config);
	const productionPreviews = getPreviewConfigFromProductionBindings(
		config,
		productionBindings
	);
	const workerName = resolveWorkerName(args, config);
	let baseConfig: PreviewBaseConfig | undefined;
	if (!args.ignoreBaseConfig) {
		try {
			baseConfig = await getPreviewBaseConfig(config, accountId, workerName);
		} catch (error) {
			if (!isWorkerNotFoundError(error)) {
				throw error;
			}
		}
	}

	if (baseConfig === undefined || Object.keys(baseConfig).length === 0) {
		if (Object.keys(productionPreviews).length === 0) {
			return config;
		}
		throw missingPreviewsConfigError(
			productionPreviews,
			configPath,
			getProductionResourceWarning(productionBindings)
		);
	}

	const previews = configFromPreviewBaseConfig(baseConfig ?? {});
	if (configPath === undefined || isNonInteractiveOrCI()) {
		throw missingPreviewsConfigError(previews, configPath);
	}

	if (
		!(await confirm(
			"Would you like Wrangler to add the Preview Base configuration to your config file?"
		))
	) {
		throw missingPreviewsConfigError(previews, configPath);
	}

	try {
		experimental_patchConfig(configPath, { previews }, false);
	} catch (error) {
		if (error instanceof PatchConfigError) {
			throw missingPreviewsConfigError(previews, configPath);
		}
		throw error;
	}

	return { ...config, previews };
}

export const previewCommand = createCommand({
	metadata: {
		description: "👀 Create a Preview deployment of the current Worker",
		owner: "Workers: Deploy and Config",
		category: "Compute & AI",
		status: "private beta",
	},
	positionalArgs: ["script"],
	args: {
		script: {
			describe: "The path to an entry point for your Worker",
			type: "string",
			requiresArg: true,
		},
		name: {
			describe: "Name of the Preview (defaults to current git branch)",
			type: "string",
			requiresArg: true,
		},
		tag: {
			describe: "A tag for this Preview deployment",
			type: "string",
			requiresArg: true,
		},
		message: {
			describe: "A descriptive message for this Preview deployment",
			type: "string",
			requiresArg: true,
		},
		json: {
			describe: "Return output as JSON",
			type: "boolean",
			default: false,
		},
		"ignore-base-config": {
			describe:
				"Only use settings from your config file, ignoring the Preview base config configured in the Cloudflare dashboard",
			type: "boolean",
			default: false,
		},
		"worker-name": {
			describe:
				"Name of the Worker to target (defaults to the name in your local config file)",
			type: "string",
			requiresArg: true,
		},
	},
	behaviour: {
		useConfigRedirectIfAvailable: true,
		printBanner: (args) => args.json !== true,
		suggestSkillsAfterHandler: (args) => args.json !== true,
	},
	handler: async function previewHandler(args, { config }) {
		const accountId = await requireAuth(config);
		const previewConfig = await ensurePreviewsConfig(accountId, args, config);

		const entry = await getEntry(
			{ script: args.script },
			previewConfig,
			"deploy"
		);
		const destination = getWranglerTmpDir(entry.projectRoot, "preview");
		const buildResult = await buildWorker(
			{
				entry,
				name: previewConfig.name,
				compatibilityDate: previewConfig.compatibility_date,
				compatibilityFlags: previewConfig.compatibility_flags,
				uploadSourceMaps: previewConfig.upload_source_maps,
				jsxFactory: previewConfig.jsx_factory,
				jsxFragment: previewConfig.jsx_fragment,
				tsconfig: previewConfig.tsconfig,
				minify: previewConfig.minify,
				noBundle: previewConfig.no_bundle ?? false,
				defines: previewConfig.previews?.define ?? {},
				alias: { ...previewConfig.alias },
				doBindings: previewConfig.previews?.durable_objects?.bindings ?? [],
				workflowBindings: previewConfig.previews?.workflows ?? [],
				destination,
				outdir: undefined,
				metafile: undefined,
			},
			previewConfig
		);

		const assetsOptions = getAssetsOptions({
			args: { assets: undefined, script: args.script },
			config: previewConfig,
		});

		const { preview: previewResource, deployment } = await preview(
			accountId,
			args,
			previewConfig,
			buildResult,
			assetsOptions,
			{
				getNormalizedContainerOptions,
				deployPreviewContainers,
				verifyContainersScope,
			}
		);
		cleanupDestination(destination);

		writeOutput({
			type: "preview",
			version: 1,
			worker_name: previewResource.worker_name,
			preview_id: previewResource.id,
			preview_name: previewResource.name,
			preview_slug: previewResource.slug,
			preview_urls: previewResource.urls,
			deployment_id: deployment.id,
			deployment_urls: deployment.urls,
		});
	},
});
