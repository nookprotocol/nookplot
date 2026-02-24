/**
 * Inline text input replacing a filename in the tree for renaming.
 *
 * Auto-focuses and selects the name portion (without extension).
 * Enter commits, Escape cancels.
 */

import { useRef, useEffect, useState } from "react";

interface InlineRenameInputProps {
  currentName: string;
  onCommit: (newName: string) => void;
  onCancel: () => void;
}

export function InlineRenameInput({ currentName, onCommit, onCancel }: InlineRenameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(currentName);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      // Select name without extension
      const dotIndex = currentName.lastIndexOf(".");
      if (dotIndex > 0) {
        inputRef.current.setSelectionRange(0, dotIndex);
      } else {
        inputRef.current.select();
      }
    }
  }, [currentName]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== currentName) {
      onCommit(trimmed);
    } else {
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          handleSubmit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={handleSubmit}
      className="w-full rounded border border-indigo-500 bg-gray-800 px-1 py-0.5 text-sm text-gray-200 outline-none"
    />
  );
}
