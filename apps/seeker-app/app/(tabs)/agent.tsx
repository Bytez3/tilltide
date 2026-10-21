import { useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { SetupCard } from '@/components/setup-card'
import { Button } from '@/components/ui'
import { colors, ui } from '@/constants/theme'
import { useMerchant } from '@/features/merchant/merchant-provider'
import { useSignSweep } from '@/features/sweep/use-sweep'
import { api, ChatTurn, Sweep } from '@/lib/api'
import { shortAddress } from '@/lib/format'

const SUGGESTIONS = ['What did I take today?', 'Who are my top customers?', 'Reconcile today and suggest a sweep']

export default function AgentScreen() {
  const { merchant } = useMerchant()
  const signSweep = useSignSweep(merchant)
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [sweep, setSweep] = useState<Sweep | null>(null)
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
    if (!merchant || !text.trim()) return
    const next: ChatTurn[] = [...turns, { role: 'user', content: text.trim() }]
    setTurns(next)
    setDraft('')
    setThinking(true)
    setError(null)
    try {
      const { reply, sweeps } = await api.chat(merchant.id, next)
      setTurns([...next, { role: 'assistant', content: reply }])
      if (sweeps.length) setSweep(sweeps.at(-1)!)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setThinking(false)
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50)
    }
  }

  async function confirmSweep() {
    if (!sweep) return
    setSigning(true)
    setError(null)
    try {
      setSweep(await signSweep(sweep))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSigning(false)
    }
  }

  async function cancelSweep() {
    if (!sweep) return
    await api.cancelSweep(sweep.id).catch(() => null)
    setSweep(null)
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
        {sweep && (
          <View style={[ui.card, { borderColor: colors.sea, borderWidth: 1 }]}>
            <Text style={ui.muted}>Proposed sweep</Text>
            <Text style={ui.h1}>
              {Number(sweep.display).toFixed(2)} {sweep.token}
            </Text>
            <Text style={ui.body}>To owner wallet {shortAddress(sweep.toWallet)}</Text>
            {sweep.reason && <Text style={ui.muted}>{sweep.reason}</Text>}
            {sweep.status === 'proposed' ? (
              <View style={ui.row}>
                <Button title="Cancel" variant="secondary" onPress={cancelSweep} style={{ flex: 1 }} />
                <Button title="Confirm & sign" onPress={confirmSweep} loading={signing} style={{ flex: 2 }} />
              </View>
            ) : (
              <Text style={{ color: sweep.status === 'confirmed' ? colors.paid : colors.muted, fontWeight: '600' }}>
                {sweep.status === 'confirmed' ? 'Sent ✓' : 'Cancelled'}
              </Text>
            )}
          </View>
        )}
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
        <Button title="Send" onPress={() => send(draft)} disabled={!draft.trim() || thinking} style={{ paddingHorizontal: 18 }} />
      </View>
    </KeyboardAvoidingView>
  )
}
