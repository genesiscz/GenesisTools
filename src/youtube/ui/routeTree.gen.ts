/* eslint-disable */

// @ts-nocheck

// noinspection JSUnusedGlobalSymbols

import { Route as rootRouteImport } from "./routes/__root";
import { Route as ChannelsHandleRouteImport } from "./routes/channels.$handle";
import { Route as FirstRunRouteImport } from "./routes/first-run";
import { Route as IndexRouteImport } from "./routes/index";
import { Route as JobsRouteImport } from "./routes/jobs";
import { Route as SettingsRouteImport } from "./routes/settings";
import { Route as VideosIdRouteImport } from "./routes/videos.$id";

const ChannelsHandleRoute = ChannelsHandleRouteImport.update({
    id: "/channels/$handle",
    path: "/channels/$handle",
    getParentRoute: () => rootRouteImport,
} as any);

const FirstRunRoute = FirstRunRouteImport.update({
    id: "/first-run",
    path: "/first-run",
    getParentRoute: () => rootRouteImport,
} as any);

const IndexRoute = IndexRouteImport.update({
    id: "/",
    path: "/",
    getParentRoute: () => rootRouteImport,
} as any);

const JobsRoute = JobsRouteImport.update({
    id: "/jobs",
    path: "/jobs",
    getParentRoute: () => rootRouteImport,
} as any);

const SettingsRoute = SettingsRouteImport.update({
    id: "/settings",
    path: "/settings",
    getParentRoute: () => rootRouteImport,
} as any);

const VideosIdRoute = VideosIdRouteImport.update({
    id: "/videos/$id",
    path: "/videos/$id",
    getParentRoute: () => rootRouteImport,
} as any);

export interface FileRoutesByFullPath {
    "/": typeof IndexRoute;
    "/channels/$handle": typeof ChannelsHandleRoute;
    "/first-run": typeof FirstRunRoute;
    "/jobs": typeof JobsRoute;
    "/settings": typeof SettingsRoute;
    "/videos/$id": typeof VideosIdRoute;
}

export interface FileRoutesByTo {
    "/": typeof IndexRoute;
    "/channels/$handle": typeof ChannelsHandleRoute;
    "/first-run": typeof FirstRunRoute;
    "/jobs": typeof JobsRoute;
    "/settings": typeof SettingsRoute;
    "/videos/$id": typeof VideosIdRoute;
}

export interface FileRoutesById {
    __root__: typeof rootRouteImport;
    "/": typeof IndexRoute;
    "/channels/$handle": typeof ChannelsHandleRoute;
    "/first-run": typeof FirstRunRoute;
    "/jobs": typeof JobsRoute;
    "/settings": typeof SettingsRoute;
    "/videos/$id": typeof VideosIdRoute;
}

export interface FileRouteTypes {
    fileRoutesByFullPath: FileRoutesByFullPath;
    fullPaths: "/" | "/channels/$handle" | "/first-run" | "/jobs" | "/settings" | "/videos/$id";
    fileRoutesByTo: FileRoutesByTo;
    to: "/" | "/channels/$handle" | "/first-run" | "/jobs" | "/settings" | "/videos/$id";
    id: "__root__" | "/" | "/channels/$handle" | "/first-run" | "/jobs" | "/settings" | "/videos/$id";
    fileRoutesById: FileRoutesById;
}

export interface RootRouteChildren {
    IndexRoute: typeof IndexRoute;
    ChannelsHandleRoute: typeof ChannelsHandleRoute;
    FirstRunRoute: typeof FirstRunRoute;
    JobsRoute: typeof JobsRoute;
    SettingsRoute: typeof SettingsRoute;
    VideosIdRoute: typeof VideosIdRoute;
}

declare module "@tanstack/react-router" {
    interface FileRoutesByPath {
        "/": {
            id: "/";
            path: "/";
            fullPath: "/";
            preLoaderRoute: typeof IndexRouteImport;
            parentRoute: typeof rootRouteImport;
        };
        "/channels/$handle": {
            id: "/channels/$handle";
            path: "/channels/$handle";
            fullPath: "/channels/$handle";
            preLoaderRoute: typeof ChannelsHandleRouteImport;
            parentRoute: typeof rootRouteImport;
        };
        "/first-run": {
            id: "/first-run";
            path: "/first-run";
            fullPath: "/first-run";
            preLoaderRoute: typeof FirstRunRouteImport;
            parentRoute: typeof rootRouteImport;
        };
        "/jobs": {
            id: "/jobs";
            path: "/jobs";
            fullPath: "/jobs";
            preLoaderRoute: typeof JobsRouteImport;
            parentRoute: typeof rootRouteImport;
        };
        "/settings": {
            id: "/settings";
            path: "/settings";
            fullPath: "/settings";
            preLoaderRoute: typeof SettingsRouteImport;
            parentRoute: typeof rootRouteImport;
        };
        "/videos/$id": {
            id: "/videos/$id";
            path: "/videos/$id";
            fullPath: "/videos/$id";
            preLoaderRoute: typeof VideosIdRouteImport;
            parentRoute: typeof rootRouteImport;
        };
    }
}

const rootRouteChildren: RootRouteChildren = {
    IndexRoute,
    ChannelsHandleRoute,
    FirstRunRoute,
    JobsRoute,
    SettingsRoute,
    VideosIdRoute,
};

export const routeTree = rootRouteImport._addFileChildren(rootRouteChildren)._addFileTypes<FileRouteTypes>();
