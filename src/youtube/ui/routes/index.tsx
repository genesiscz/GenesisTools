import { createFileRoute } from "@tanstack/react-router";
import { ChannelsGrid } from "@app/yt/components/channels/channels-grid";

export const Route = createFileRoute("/")({ component: ChannelsGrid });
