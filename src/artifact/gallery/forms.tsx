import { Button, DateInput, Field, FileInput, NumberInput, Select, Textarea, TextInput } from "@artifact/kit";
import { useState } from "react";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Forms",
    title: "Form controls",
    summary: "Button, Field and the inputs that go in it. Dates are YYYY-MM-DD strings, numbers keep a draft.",
    components: ["Button", "Field", "TextInput", "NumberInput", "DateInput", "Select", "Textarea", "FileInput"],
};

export default function FormsPage() {
    const [name, setName] = useState("Atlas portal");
    const [hours, setHours] = useState<number | null>(6.5);
    const [start, setStart] = useState("2026-10-12");
    const [team, setTeam] = useState("");
    const [notes, setNotes] = useState("");
    const [file, setFile] = useState("no file yet");
    const [busy, setBusy] = useState(false);

    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Every control shows a 2 px focus ring. Up and Down step a number input; Enter commits its draft and Escape drops it. The file zone is a real file input: Tab reaches it and Space opens the picker."
        >
            <Demo title="A form row">
                <div className="grid gap-3 md:grid-cols-3">
                    <Field label="Project name" hint="Shown in the page header" required>
                        <TextInput value={name} onChange={setName} />
                    </Field>
                    <Field label="Hours per day">
                        <NumberInput value={hours} onChange={setHours} min={0} max={24} step={0.5} unit="h" />
                    </Field>
                    <Field label="Start">
                        <DateInput value={start} onChange={setStart} min="2026-09-01" />
                    </Field>
                    <Field label="Team" error={team ? undefined : "Pick a team"}>
                        <Select
                            value={team}
                            onChange={setTeam}
                            placeholder="Choose a team"
                            options={[
                                { value: "platform", label: "Platform" },
                                { value: "client", label: "Client apps" },
                            ]}
                        />
                    </Field>
                    <Field label="Notes">
                        <Textarea value={notes} onChange={setNotes} rows={2} />
                    </Field>
                </div>
                <div className="mt-3 flex gap-2">
                    <Button
                        variant="primary"
                        busy={busy}
                        onClick={() => {
                            setBusy(true);
                            setTimeout(() => setBusy(false), 1200);
                        }}
                    >
                        Save
                    </Button>
                    <Button>Cancel</Button>
                    <Button variant="ghost">Reset</Button>
                    <Button variant="danger">Delete</Button>
                    <Button disabled>Disabled</Button>
                </div>
            </Demo>
            <Demo title="Edge case: a file over the size limit" note={file}>
                <FileInput
                    accept=".csv,.txt"
                    maxBytes={2048}
                    read="text"
                    hint="CSV or text, up to 2 KB, read in the page"
                    onFiles={(files) =>
                        setFile(files.map((f) => `${f.file.name}: ${f.text?.length ?? 0} characters`).join(", "))
                    }
                />
            </Demo>
        </GalleryPage>
    );
}
