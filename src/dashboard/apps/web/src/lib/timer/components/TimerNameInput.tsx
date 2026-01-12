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

  // Fixed height container to prevent height jumps
  const containerHeight = 'h-8'

  if (isEditing) {
    return (
      <div className={cn('flex items-center gap-1.5', containerHeight, className)}>
        <div className="relative flex-1">
          {/* Terminal prompt */}
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-amber-500/70 font-mono text-xs">
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
              'w-full h-8 bg-black/50 border border-amber-500/40 rounded-md',
              'pl-7 pr-3 text-sm font-semibold text-white',
              'font-mono tracking-wide',
              'focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/50',
              'placeholder:text-gray-600'
            )}
            placeholder="Timer name..."
            maxLength={32}
          />
        </div>

        {/* Action buttons - smaller */}
        <button
          onClick={handleSave}
          className="p-1.5 rounded-md bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
          title="Save"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={handleCancel}
          className="p-1.5 rounded-md bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
          title="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={() => setIsEditing(true)}
      className={cn(
        'group flex items-center gap-1.5 text-left',
        containerHeight,
        'hover:bg-amber-500/5 rounded-md px-1.5 -mx-1.5',
        'transition-colors duration-200',
        className
      )}
      title="Click to edit"
    >
      <span className="text-sm font-semibold text-white truncate max-w-[160px]">
        {name}
      </span>
      <Pencil className="h-3 w-3 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
    </button>
  )
})
