import { useState, useEffect } from 'react'
import { Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { DistractionLogModal } from './DistractionLogModal'
import type { DistractionSource, Task } from '@/lib/assistant/types'

interface QuickLogButtonProps {
  onLog: (source: DistractionSource, description?: string, taskInterrupted?: string) => Promise<void>
  currentTask?: Task | null
  loading?: boolean
  className?: string
}

/**
 * QuickLogButton - Floating action button to quickly log distractions
 *
 * Features:
 * - Subtle pulse animation to draw attention
 * - Keyboard shortcut (Ctrl+D or Cmd+D)
 * - Neon cyberpunk styling
 * - Opens DistractionLogModal
 */
export function QuickLogButton({
  onLog,
  currentTask,
  loading = false,
  className,
}: QuickLogButtonProps) {
  const [isModalOpen, setIsModalOpen] = useState(false)

  // Keyboard shortcut handler
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl+D or Cmd+D to open distraction log
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault()
        setIsModalOpen(true)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={() => setIsModalOpen(true)}
              disabled={loading}
              className={cn(
                'fixed bottom-6 right-6 z-50',
                'h-14 w-14 rounded-full p-0',
                'bg-gradient-to-br from-cyan-600 to-cyan-700',
                'hover:from-cyan-500 hover:to-cyan-600',
                'border border-cyan-400/30',
                'shadow-lg shadow-cyan-500/25',
                'transition-all duration-300',
                'hover:scale-110 hover:shadow-xl hover:shadow-cyan-500/40',
                'group',
                className
              )}
              style={{
                boxShadow: '0 0 30px rgba(6, 182, 212, 0.3)',
              }}
            >
              {/* Pulse ring animation */}
              <span className="absolute inset-0 rounded-full">
                <span
                  className={cn(
                    'absolute inset-0 rounded-full',
                    'bg-cyan-400/20',
                    'animate-ping'
                  )}
                  style={{ animationDuration: '3s' }}
                />
              </span>

              {/* Icon */}
              <Zap
                className={cn(
                  'h-6 w-6 text-white',
                  'transition-transform duration-200',
                  'group-hover:scale-110'
                )}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left" className="bg-[#0a0a14] border-cyan-500/20">
            <p className="flex items-center gap-2">
              <span>Log Distraction</span>
              <kbd className="px-1.5 py-0.5 text-[10px] bg-white/10 rounded border border-white/20">
                Ctrl+D
              </kbd>
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <DistractionLogModal
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        onLog={onLog}
        currentTask={currentTask}
        loading={loading}
      />
    </>
  )
}
