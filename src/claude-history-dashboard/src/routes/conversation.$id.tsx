import { createFileRoute, Link } from '@tanstack/react-router'
import { getConversation } from '@/server/conversations'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ArrowLeft, Bot, User, Wrench, GitBranch, Calendar, FolderOpen } from 'lucide-react'

export const Route = createFileRoute('/conversation/$id')({
  component: ConversationPage,
  loader: ({ params }) => getConversation({ data: params.id }),
})

function ConversationPage() {
  const conversation = Route.useLoaderData()

  if (!conversation) {
    return (
      <div className="min-h-screen bg-[var(--bg-primary)] flex items-center justify-center">
        <Card className="bg-[var(--bg-secondary)] border-[var(--border-primary)] p-8">
          <p className="text-[var(--text-secondary)]">Conversation not found</p>
          <Link
            to="/"
            className="mt-4 text-[var(--neon-primary)] hover:underline flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" /> Back to conversations
          </Link>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-[var(--bg-primary)]/95 backdrop-blur border-b border-[var(--border-primary)]">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] mb-3"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to conversations
          </Link>
          <h1 className="text-xl font-bold text-[var(--text-primary)] line-clamp-2">
            {conversation.customTitle || conversation.summary || conversation.sessionId}
          </h1>
          <div className="flex flex-wrap items-center gap-3 mt-3 text-xs text-[var(--text-muted)]">
            <Badge
              variant="outline"
              className="border-[var(--neon-secondary)]/30 text-[var(--neon-secondary)]"
            >
              <FolderOpen className="w-3 h-3 mr-1" />
              {conversation.project}
            </Badge>
            {conversation.gitBranch && (
              <span className="flex items-center gap-1">
                <GitBranch className="w-3.5 h-3.5" />
                {conversation.gitBranch}
              </span>
            )}
            <span className="flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" />
              {new Date(conversation.timestamp).toLocaleString('en-US', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            {conversation.isSubagent && (
              <Badge
                variant="outline"
                className="border-[var(--neon-primary)]/30 text-[var(--neon-primary)]"
              >
                Subagent
              </Badge>
            )}
          </div>
        </div>
      </header>

      {/* Messages */}
      <ScrollArea className="h-[calc(100vh-160px)]">
        <div className="max-w-5xl mx-auto px-6 py-6">
          <div className="space-y-4">
            {conversation.messages
              .filter((msg) => msg.type === 'user' || msg.type === 'assistant')
              .map((msg, idx) => (
                <MessageCard key={idx} message={msg} />
              ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}

function MessageCard({
  message,
}: {
  message: {
    type: string
    role?: string
    content: string
    timestamp?: string
    toolUses?: Array<{ name: string; input?: object }>
  }
}) {
  const isUser = message.type === 'user'

  return (
    <Card
      className={`border ${
        isUser
          ? 'bg-[var(--neon-primary)]/5 border-[var(--neon-primary)]/20'
          : 'bg-[var(--bg-secondary)] border-[var(--border-primary)]'
      }`}
    >
      <CardHeader className="pb-2 pt-3 px-4">
        <div className="flex items-center gap-2">
          {isUser ? (
            <User className="w-4 h-4 text-[var(--neon-primary)]" />
          ) : (
            <Bot className="w-4 h-4 text-[var(--neon-secondary)]" />
          )}
          <span
            className={`text-sm font-medium ${
              isUser ? 'text-[var(--neon-primary)]' : 'text-[var(--neon-secondary)]'
            }`}
          >
            {isUser ? 'User' : 'Assistant'}
          </span>
          {message.timestamp && (
            <span className="text-xs text-[var(--text-muted)] ml-auto">
              {new Date(message.timestamp).toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="prose prose-sm prose-invert max-w-none">
          <pre className="whitespace-pre-wrap text-sm text-[var(--text-primary)] font-sans leading-relaxed">
            {message.content || '(empty)'}
          </pre>
        </div>
        {message.toolUses && message.toolUses.length > 0 && (
          <div className="mt-3 pt-3 border-t border-[var(--border-primary)]">
            <div className="flex flex-wrap gap-2">
              {message.toolUses.map((tool, i) => (
                <Badge
                  key={i}
                  variant="outline"
                  className="border-[var(--neon-secondary)]/30 text-[var(--text-muted)] text-xs"
                >
                  <Wrench className="w-3 h-3 mr-1" />
                  {tool.name}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
