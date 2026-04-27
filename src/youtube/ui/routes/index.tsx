import { createFileRoute } from "@tanstack/react-router";
import { ChannelsGrid } from "@yt/components/channels/channels-grid";

export const Route = createFileRoute("/")({ component: ChannelsGrid });
