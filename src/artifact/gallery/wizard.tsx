import { DateInput, Field, FileInput, Note, NumberInput, Select, TextInput, Wizard } from "@artifact/kit";
import { useState } from "react";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Forms",
    title: "Wizard",
    summary: "A multi-step setup: validation blocks Next, optional steps offer Skip, typed values survive Back.",
    components: ["Wizard"],
};

export default function WizardPage() {
    const [source, setSource] = useState("");
    const [file, setFile] = useState("");
    const [lanes, setLanes] = useState<number | null>(3);
    const [start, setStart] = useState("2026-10-12");
    const [team, setTeam] = useState("platform");
    const [done, setDone] = useState("Not finished yet.");

    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Enter in a one-line field runs Next. The stepper is a list of buttons; locked steps say so. Focus moves to the step heading on each change."
        >
            <Demo title="Linear setup" note={done}>
                <Wizard
                    hash
                    onFinish={async () => {
                        await new Promise((resolve) => setTimeout(resolve, 600));
                        setDone(`Created with ${lanes ?? 0} lanes starting ${start}.`);
                    }}
                    steps={[
                        {
                            id: "source",
                            label: "Source",
                            description: "Where the work items come from.",
                            validate: () => (source.trim() || file ? true : "Enter a root item id or pick a file"),
                            content: (
                                <div className="grid gap-3 md:grid-cols-2">
                                    <Field label="Root item id" hint="The parent of everything in the plan">
                                        <TextInput
                                            value={source}
                                            onChange={setSource}
                                            placeholder="for example 1200"
                                            mono
                                        />
                                    </Field>
                                    <FileInput
                                        accept=".csv"
                                        read="text"
                                        label="Or choose a CSV export"
                                        onFiles={(files) => setFile(files[0]?.file.name ?? "")}
                                    />
                                </div>
                            ),
                        },
                        {
                            id: "lanes",
                            label: "Lanes",
                            validate: () => ((lanes ?? 0) > 0 ? true : "A plan needs at least one lane"),
                            content: (
                                <Field label="How many lanes">
                                    <NumberInput value={lanes} onChange={setLanes} min={1} max={12} />
                                </Field>
                            ),
                        },
                        {
                            id: "people",
                            label: "People",
                            optional: true,
                            content: (
                                <Field label="Team">
                                    <Select
                                        value={team}
                                        onChange={setTeam}
                                        options={[
                                            { value: "platform", label: "Platform" },
                                            { value: "client", label: "Client apps" },
                                        ]}
                                    />
                                </Field>
                            ),
                        },
                        {
                            id: "baseline",
                            label: "Baseline",
                            content: (
                                <Field label="Baseline date">
                                    <DateInput value={start} onChange={setStart} />
                                </Field>
                            ),
                        },
                    ]}
                />
            </Demo>
            <Demo title="Edge case: free mode" note="any step by click">
                <Wizard
                    mode="free"
                    steps={[
                        { id: "one", label: "Overview", content: <Note>Every step is reachable.</Note> },
                        { id: "two", label: "Details", content: <Note>Nothing validates here.</Note> },
                        { id: "three", label: "Confirm", content: <Note>Finish does nothing in this demo.</Note> },
                    ]}
                />
            </Demo>
        </GalleryPage>
    );
}
