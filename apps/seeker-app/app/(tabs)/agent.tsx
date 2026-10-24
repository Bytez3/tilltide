import { Ionicons } from '@expo/vector-icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, Text, View } from 'react-native'
import { RefundCard } from '@/components/refund-card'
import { SweepCard } from '@/components/sweep-card'
import { Input } from '@/components/ui'
import { colors, fonts, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { api, AssistantUsage, ChatTurn, Refund, Sweep } from '@/lib/api'

/** The API takes up to 40 turns of 4000 characters; keep the most recent and cut long ones. */
const MAX_TURNS = 20
const MAX_CHARS = 4000
function forApi(turns: ChatTurn[]): ChatTurn[] {
  const recent = turns.slice(-MAX_TURNS)
  // The history must start with the user.
  while (recent.length > 1 && recent[0]!.role !== 'user') recent.shift()
  return recent.map((t) => ({ role: t.role, content: t.content.slice(0, MAX_CHARS) }))
}

const SUGGESTIONS = [
  'What did I take today?',
  'What sold best today?',
  'How does today compare with yesterday?',
  'Who are my regulars?',
  'Check the till and suggest sending takings',
]

export default function AgentScreen() {
  const { merchant } = useMerchant()
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [sweep, setSweep] = useState<Sweep | null>(null)
  const [refund, setRefund] = useState<Refund | null>(null)
  const [draft, setDraft] = useState('')
  const [thinking, setThinking] = useState(false)
  const [signing, setSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scroll = useRef<ScrollView>(null)
  const queryClient = useQueryClient()
  const usage = useQuery({ queryKey: ['assistant', merchant?.id], queryFn: () => api.assistantUsage(), enabled: !!merchant })

  if (!merchant) return null

  async function send(text: string) {
    if (!merchant || !text.trim() || thinking || signing) return
    const next: ChatTurn[] = [...turns, { role: 'user', content: text.trim() }]
    setTurns(next)
    setDraft('')
    setThinking(true)
    setError(null)
    try {
      const { reply, sweeps, refunds, assistant } = await api.chat(forApi(next))
      if (assistant) queryClient.setQueryData(['assistant', merchant.id], assistant)
      if (refunds.length) setRefund(refunds.at(-1)!)
      setTurns([...next, { role: 'assistant', content: reply }])
      if (sweeps.length) setSweep(sweeps.at(-1)!)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // Take the unanswered question back out (and back into the box), so the history never has
      // two questions in a row and it's easy to try again.
      setTurns(turns)
      setDraft(text.trim())
    } finally {
      setThinking(false)
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50)
    }
  }

  const canSend = !!draft.trim() && !thinking && !signing
  return (
    <KeyboardAvoidingView style={ui.screen} behavior="padding" keyboardVerticalOffset={90}>
      <ScrollView ref={scroll} contentContainerStyle={[ui.content, { paddingBottom: 24 }]} keyboardShouldPersistTaps="handled">
        {turns.length === 0 && (
          <View style={{ gap: 14, paddingTop: 8 }}>
            <View style={{ alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: colors.sea, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="sparkles" size={26} color={colors.seaInk} />
              </View>
              <Text style={[ui.h1, { fontSize: 22, textAlign: 'center' }]}>Ask about your shop</Text>
              <Text style={[ui.muted, { textAlign: 'center', maxWidth: 320 }]}>
                Your assistant reads your sales and your till. It can set up a refund or a transfer for you, but nothing moves until you approve it.
              </Text>
            </View>
            <Text style={ui.label}>Try asking</Text>
            {SUGGESTIONS.map((s) => (
              <Pressable
                key={s}
                accessibilityRole="button"
                onPress={() => send(s)}
                style={({ pressed }) => [ui.card, ui.row, { paddingVertical: 14, justifyContent: 'space-between', backgroundColor: pressed ? colors.line : colors.card }]}
              >
                <Text style={[ui.body, { fontFamily: fonts.medium, flexShrink: 1 }]}>{s}</Text>
                <Ionicons name="arrow-forward" size={18} color={colors.sea} />
              </Pressable>
            ))}
          </View>
        )}
        {turns.map((turn, i) =>
          turn.role === 'user' ? (
            <View key={i} style={{ alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: colors.sea, borderRadius: 18, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 10 }}>
              <Text style={[ui.body, { color: colors.seaInk }]}>{turn.content}</Text>
            </View>
          ) : (
            <View key={i} style={{ alignSelf: 'flex-start', maxWidth: '92%', gap: 6 }}>
              <View style={[ui.row, { gap: 6 }]}>
                <Ionicons name="sparkles" size={13} color={colors.sea} />
                <Text style={[ui.label, { color: colors.link }]}>Tilltide</Text>
              </View>
              <View style={[ui.card, { borderRadius: 18, borderTopLeftRadius: 6 }]}>
                <Text style={ui.body}>{turn.content}</Text>
              </View>
            </View>
          ),
        )}
        {thinking && (
          <View style={[ui.row, { alignSelf: 'flex-start', gap: 8 }]}>
            <ActivityIndicator color={colors.sea} />
            <Text style={ui.muted}>Looking at your sales…</Text>
          </View>
        )}
        {sweep && <SweepCard sweep={sweep} onChange={setSweep} onBusyChange={setSigning} />}
        {refund && <RefundCard refund={refund} onChange={setRefund} onBusyChange={setSigning} />}
        {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
      </ScrollView>
      {usage.data && <UsageLine usage={usage.data} />}
      <View style={[ui.row, { paddingHorizontal: 12, paddingVertical: 10, gap: 8, borderTopColor: colors.line, borderTopWidth: 1, backgroundColor: colors.bg }]}>
        <Input
          style={{ flex: 1, minWidth: 0, borderRadius: 22, paddingHorizontal: 16 }}
          placeholder="Ask anything about your shop…"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => send(draft)}
          returnKeyType="send"
          maxLength={MAX_CHARS}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={!canSend}
          onPress={() => send(draft)}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: colors.sea,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: !canSend ? 0.4 : pressed ? 0.85 : 1,
          })}
        >
          <Ionicons name="arrow-up" size={22} color={colors.seaInk} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

/** Questions used this month; a warning from 80%, and what happens once the allowance is used. */
function UsageLine({ usage }: { usage: AssistantUsage }) {
  const { used, allowance, credits, resetsOn } = usage
  const resets = new Date(`${resetsOn}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
  const over = used >= allowance
  const near = used >= allowance * 0.8
  const text = over
    ? credits > 0
      ? `This month's ${allowance} questions are used: now using top-up questions (${credits} left).`
      : `You've used this month's ${allowance} questions. Top up or upgrade to keep asking, or wait until ${resets}.`
    : near
      ? `${used} of ${allowance} questions used this month. Resets ${resets}.`
      : `${used} of ${allowance} questions used this month`
  return (
    <Text style={[ui.muted, { textAlign: 'center', paddingHorizontal: 16, paddingTop: 6, color: near && !(over && credits > 0) ? colors.warn : colors.muted }]}>
      {text}
    </Text>
  )
}
