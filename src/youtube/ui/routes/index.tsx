import { ChannelsGrid } from "@app/yt/components/channels/channels-grid";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: ChannelsGrid });
