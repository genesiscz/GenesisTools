import { useState } from "react";

export function useNotesState() {
    const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
    const [activeTag, setActiveTag] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [createDialogOpen, setCreateDialogOpen] = useState(false);

    function selectNote(id: string | null) {
        setSelectedNoteId(id);
    }

    function toggleTag(tag: string) {
        setActiveTag((prev) => (prev === tag ? null : tag));
    }

    return {
        selectedNoteId,
        selectNote,
        activeTag,
        toggleTag,
        searchQuery,
        setSearchQuery,
        createDialogOpen,
        setCreateDialogOpen,
    };
}
