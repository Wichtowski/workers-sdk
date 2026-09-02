import { isDurableObjectContainerApp } from "@cloudflare/workers-utils";
import type { CfWorkerInit, Config } from "@cloudflare/workers-utils";

export function getContainerMetadata(
	config: Config,
	preparedContainerImages: Record<string, Record<string, string>> = {}
): CfWorkerInit["containers"] {
	const metadata =
		config.containers?.map((container) => {
			if (isDurableObjectContainerApp(container)) {
				const configuredImages = Object.keys(container.images ?? {});
				const images = preparedContainerImages[container.class_name];
				if (configuredImages.length > 0 && images === undefined) {
					throw new Error(
						`Container images for Durable Object class "${container.class_name}" were not prepared before upload.`
					);
				}
				return {
					name: container.name,
					class_name: container.class_name,
					...(images !== undefined && { images }),
				};
			}

			return {
				...(container.name !== undefined && { name: container.name }),
				...(container.class_name !== undefined && {
					class_name: container.class_name,
				}),
			};
		}) ?? [];

	return config.containers === undefined ? undefined : metadata;
}
