import { useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { RefundCard } from '@/components/refund-card'
import { SetupCard } from '@/components/setup-card'
import { SweepCard } from '@/components/sweep-card'
import { Button } from '@/components/ui'
import { colors, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { api, ChatTurn, Refund, Sweep } from '@/lib/api'

/** The API takes up to 40 turns of 4000 characters; keep the most recent and cut long ones. */
const MAX_TURNS = 20
const MAX_CHARS = 4000
function forApi(turns: ChatTurn[]): ChatTurn[] {
  const recent = turns.slice(-MAX_TURNS)
  // The history must start with the user.
  while (recent.length > 1 && recent[0]!.role !== 'user') recent.shift()
  return recent.map((t) => ({ role: t.role, content: t.content.slice(0, MAX_CHARS) }))
}

const SUGGESTIONS = ['What did I take today?', 'Who are my top customers?', 'Reconcile today and suggest a sweep']

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

  if (!merchant) {
    return (
      <View style={[ui.screen, ui.content]}>
        <SetupCard />
      </View>
    )
  }

  async function send(text: string) {
    if (!merchant || !text.trim() || thinking || signing) return
    const next: ChatTurn[] = [...turns, { role: 'user', content: text.trim() }]
    setTurns(next)
    setDraft('')
    setThinking(true)
    setError(null)
    try {
      const { reply, sweeps, refunds } = await api.chat(forApi(next))
      if (refunds.length) setRefund(refunds.at(-1)!)
      setTurns([...next, { role: 'assistant', content: reply }])
      if (sweeps.length) setSweep(sweeps.at(-1)!)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setThinking(false)
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50)
    }
  }

  return (
    <KeyboardAvoidingView style={ui.screen} behavior="padding" keyboardVerticalOffset={90}>
      <ScrollView ref={scroll} contentContainerStyle={ui.content}>
        {turns.length === 0 && (
          <View style={ui.card}>
            <Text style={ui.h2}>Ask about your shop</Text>
            <Text style={ui.muted}>The agent reads your sales and the chain. It can suggest moving takings to you, but only you can approve it.</Text>
            {SUGGESTIONS.map((s) => (
              <Pressable key={s} onPress={() => send(s)} style={[ui.input, { marginTop: 4 }]}>
                <Text style={ui.body}>{s}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {turns.map((turn, i) => (
          <View
            key={i}
            style={[
              ui.card,
              turn.role === 'user'
                ? { alignSelf: 'flex-end', backgroundColor: colors.sea, borderColor: colors.sea, maxWidth: '85%' }
                : { alignSelf: 'flex-start', maxWidth: '92%' },
            ]}
          >
            <Text style={[ui.body, turn.role === 'user' && { color: colors.seaInk }]}>{turn.content}</Text>
          </View>
        ))}
        {thinking && <ActivityIndicator color={colors.sea} style={{ alignSelf: 'flex-start' }} />}
        {sweep && <SweepCard sweep={sweep} onChange={setSweep} onBusyChange={setSigning} />}
        {refund && <RefundCard refund={refund} onChange={setRefund} onBusyChange={setSigning} />}
        {error && <Text style={[ui.muted, { color: colors.danger }]}>{error}</Text>}
      </ScrollView>
      <View style={[ui.row, { padding: 12, borderTopColor: colors.line, borderTopWidth: 1 }]}>
        <TextInput
          style={[ui.input, { flex: 1 }]}
          placeholder="Ask the agent…"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => send(draft)}
          returnKeyType="send"
        />
        <Button title="Send" onPress={() => send(draft)} disabled={!draft.trim() || thinking || signing} style={{ paddingHorizontal: 18 }} />
      </View>
    </KeyboardAvoidingView>
  )
}
