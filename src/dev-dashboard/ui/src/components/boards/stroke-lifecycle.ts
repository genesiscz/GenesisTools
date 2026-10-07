import type { StrokeDto } from "@app/dev-dashboard/contract/dto";

export interface StrokeLifecycleOptions {
    tempId: number;
    create: () => Promise<StrokeDto | undefined>;
    removeLocal: (id: number) => void;
    commitLocal: (tempId: number, stroke: StrokeDto) => void;
    addLocal: (stroke: StrokeDto) => void;
    deleteRemote: (id: number) => Promise<unknown>;
    onCreateError: (error: unknown) => void;
}

export interface StrokeLifecycle {
    undo: () => Promise<void>;
    redo: () => Promise<void>;
}

/** Orders the initial stroke creation with undo so a temporary id never reaches DELETE. */
export function createStrokeLifecycle(options: StrokeLifecycleOptions): StrokeLifecycle {
    let desiredVisible = true;
    let serverStroke: StrokeDto | undefined;
    const initialCreate = options.create().then(
        (stroke) => {
            serverStroke = stroke;

            if (!stroke) {
                options.removeLocal(options.tempId);
                return undefined;
            }

            if (desiredVisible) {
                options.commitLocal(options.tempId, stroke);
            } else {
                options.removeLocal(stroke.id);
            }

            return stroke;
        },
        (error) => {
            options.removeLocal(options.tempId);
            options.onCreateError(error);
            return undefined;
        }
    );

    return {
        undo: async () => {
            desiredVisible = false;
            options.removeLocal(options.tempId);

            if (serverStroke) {
                options.removeLocal(serverStroke.id);
            }

            await initialCreate;
            if (serverStroke) {
                await options.deleteRemote(serverStroke.id);
            }
        },
        redo: async () => {
            desiredVisible = true;
            const created = await options.create();

            if (created) {
                serverStroke = created;
                options.addLocal(created);
            }
        },
    };
}
