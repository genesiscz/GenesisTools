export interface ContainerInfo {
    id: string;
    name: string;
    image: string;
    state: string;
    status: string;
    ports: string;
}

export interface ContainersResult {
    dockerAvailable: boolean;
    containers: ContainerInfo[];
}
