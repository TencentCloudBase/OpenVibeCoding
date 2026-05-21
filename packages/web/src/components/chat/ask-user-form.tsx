import { useState, type Dispatch, type SetStateAction } from 'react'
import { HelpCircle, Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import type { AskUserQuestionData } from '@/types/task-chat'

interface AskUserFormProps {
  askData?: AskUserQuestionData
  agentMessageId: string
  toolCallId: string
  questionAnswers: Record<string, string>
  manualInputs: Record<string, string>
  isSending: boolean
  onAnswerSelect: (toolCallId: string, header: string, label: string) => void
  onManualInput: (toolCallId: string, header: string, value: string) => void
  onSubmit: (askData: AskUserQuestionData) => void
}

export function AskUserForm({
  askData,
  agentMessageId,
  toolCallId,
  questionAnswers,
  manualInputs,
  isSending,
  onAnswerSelect,
  onManualInput,
  onSubmit,
}: AskUserFormProps) {
  const questions = askData?.questions || []
  if (!askData || questions.length === 0) return null
  const allAnswered = questions.every((q) => questionAnswers[q.question] || manualInputs[q.question])

  return (
    <Card className="p-3 border-primary/40 bg-primary/5">
      <div className="flex items-center gap-2 mb-3">
        <HelpCircle className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">请回答以下问题</span>
      </div>

      <div className="space-y-3">
        {questions.map((question, idx) => {
          const header = question.header
          return (
            <div key={idx} className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs">
                  {header}
                </Badge>
                <span className="text-xs text-muted-foreground">{question.question}</span>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {(question.options || []).map((option, optIdx) => (
                  <Button
                    key={optIdx}
                    variant={questionAnswers[question.question] === option.label ? 'default' : 'outline'}
                    size="sm"
                    className="h-auto py-1.5 px-2 text-xs flex flex-col items-start gap-0"
                    disabled={isSending}
                    onClick={() => onAnswerSelect(toolCallId, question.question, option.label)}
                  >
                    <span>{option.label}</span>
                    {option.description && <span className="text-[10px] opacity-70">{option.description}</span>}
                  </Button>
                ))}
              </div>

              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-muted-foreground">其他答案:</span>
                <Input
                  className="h-7 text-xs flex-1"
                  placeholder="输入自定义答案..."
                  value={manualInputs[question.question] || ''}
                  disabled={isSending}
                  onChange={(e) => onManualInput(toolCallId, question.question, e.target.value)}
                />
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex justify-end gap-2 mt-3">
        <Button
          size="sm"
          onClick={() => onSubmit({ ...askData, assistantMessageId: agentMessageId })}
          disabled={isSending || !allAnswered}
        >
          {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : '提交答案'}
        </Button>
      </div>
    </Card>
  )
}
