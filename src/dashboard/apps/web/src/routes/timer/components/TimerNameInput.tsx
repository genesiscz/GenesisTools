import { memo, useState, useRef, useEffect, useCallback } from 'react'
import { Pencil, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface TimerNameInputProps {
  name: string
  onNameChange: (name: string) => void
  className?: string
}

/**
 * Inline editable timer name with cyberpunk terminal styling
 */
export const TimerNameInput = memo(function TimerNameInput({
  name,
  onNameChange,
  className,
}: TimerNameInputProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  // Sync external name changes
  useEffect(() => {
    if (!isEditing) {
      setEditValue(name)
    }
  }, [name, isEditing])

  const handleSave = useCallback(() => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== name) {
      onNameChange(trimmed)
    } else {
      setEditValue(name)
    }
    setIsEditing(false)
  }, [editValue, name, onNameChange])

  const handleCancel = useCallback(() => {
    setEditValue(name)
    setIsEditing(false)
  }, [name])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSave()
      } else if (e.key === 'Escape') {
        handleCancel()
      }
    },
    [handleSave, handleCancel]
  )

  if (isEditing) {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <div className="relative flex-1">
          {/* Terminal prompt */}
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-amber-500/70 font-mono text-sm">
            {'>>'}
          </span>
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleSave}
            className={cn(
              'w-full bg-black/50 border border-amber-500/40 rounded-lg',
              'pl-10 pr-4 py-2 text-lg font-semibold text-white',
              'font-mono tracking-wide',
              'focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/50',
              'placeholder:text-gray-600'
            )}
            placeholder="Timer name..."
            maxLength={32}
          />
          {/* Blinking cursor effect */}
          <span className="absolute right-3 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-amber-500 animate-pulse" />
        </div>

        {/* Action buttons */}
        <button
          onClick={handleSave}
          className="p-2 rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
          title="Save"
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          onClick={handleCancel}
          className="p-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
          title="Cancel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={() => setIsEditing(true)}
      className={cn(
        'group flex items-center gap-2 text-left',
        'hover:bg-amber-500/5 rounded-lg px-2 py-1 -mx-2 -my-1',
        'transition-colors duration-200',
        className
      )}
      title="Click to edit"
    >
      <span className="text-lg font-semibold text-white truncate max-w-[200px]">
        {name}
      </span>
      <Pencil className="h-3.5 w-3.5 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  )
})
