import { MaterialCommunityIcons } from '@expo/vector-icons'
import { View } from 'react-native'
import { Tint, tints } from '@/constants/theme'

type Glyph = keyof typeof MaterialCommunityIcons.glyphMap

/** Every icon a menu item can have (keys match ITEM_ICONS on the server), with its glyph and colour family. */
export const ITEM_ICONS: Record<string, { glyph: Glyph; tint: Tint; label: string }> = {
  pastry: { glyph: 'food-croissant', tint: 'amber', label: 'Pastry' },
  bread: { glyph: 'baguette', tint: 'amber', label: 'Bread' },
  cake: { glyph: 'cake-variant', tint: 'pink', label: 'Cake' },
  cupcake: { glyph: 'cupcake', tint: 'pink', label: 'Cupcake' },
  cookie: { glyph: 'cookie', tint: 'amber', label: 'Biscuit' },
  icecream: { glyph: 'ice-cream', tint: 'pink', label: 'Ice cream' },
  coffee: { glyph: 'coffee', tint: 'brown', label: 'Coffee' },
  tea: { glyph: 'tea', tint: 'brown', label: 'Tea' },
  soda: { glyph: 'bottle-soda', tint: 'blue', label: 'Soft drink' },
  water: { glyph: 'cup-water', tint: 'blue', label: 'Water' },
  beer: { glyph: 'beer', tint: 'amber', label: 'Beer' },
  wine: { glyph: 'glass-wine', tint: 'purple', label: 'Wine' },
  pizza: { glyph: 'pizza', tint: 'coral', label: 'Pizza' },
  burger: { glyph: 'hamburger', tint: 'coral', label: 'Burger' },
  sandwich: { glyph: 'food', tint: 'coral', label: 'Sandwich' },
  noodles: { glyph: 'noodles', tint: 'coral', label: 'Hot food' },
  fish: { glyph: 'fish', tint: 'blue', label: 'Fish' },
  veg: { glyph: 'carrot', tint: 'green', label: 'Veg' },
  fruit: { glyph: 'fruit-cherries', tint: 'green', label: 'Fruit' },
  flower: { glyph: 'flower', tint: 'purple', label: 'Flowers' },
  gift: { glyph: 'gift-outline', tint: 'purple', label: 'Gift' },
  clothing: { glyph: 'tshirt-crew-outline', tint: 'blue', label: 'Clothing' },
  book: { glyph: 'book-open-variant', tint: 'blue', label: 'Book' },
  other: { glyph: 'tag-outline', tint: 'gray', label: 'Other' },
}

const GUESSES: [RegExp, string][] = [
  [/coffee|latte|espresso|cappuccino|americano|flat white|mocha/i, 'coffee'],
  [/\btea\b|chai|infusion/i, 'tea'],
  [/pasty|pastie|croissant|pastry|pain au|danish|sausage roll/i, 'pastry'],
  [/scone|cake|brownie|tart|slice|flapjack/i, 'cake'],
  [/cupcake|muffin/i, 'cupcake'],
  [/bun|bread|loaf|roll|bagel|baguette|sourdough/i, 'bread'],
  [/cookie|biscuit|shortbread/i, 'cookie'],
  [/ice ?cream|gelato|sorbet|lolly/i, 'icecream'],
  [/beer|ale|lager|cider|stout|ipa/i, 'beer'],
  [/wine|prosecco|fizz|gin|spirit/i, 'wine'],
  [/water/i, 'water'],
  [/coke|cola|lemonade|juice|soda|squash|smoothie|milkshake/i, 'soda'],
  [/pizza/i, 'pizza'],
  [/burger/i, 'burger'],
  [/sandwich|toastie|wrap|panini|baguette/i, 'sandwich'],
  [/soup|chips|fries|noodle|curry|stew|hot dog/i, 'noodles'],
  [/fish|crab|mackerel|cod|lobster/i, 'fish'],
  [/veg|salad|potato|carrot/i, 'veg'],
  [/fruit|apple|berr|cherr|banana/i, 'fruit'],
  [/flower|bouquet|plant/i, 'flower'],
  [/gift|voucher|card/i, 'gift'],
  [/shirt|hat|hoodie|sock|tote/i, 'clothing'],
  [/book|map|guide/i, 'book'],
]

/** A sensible icon from an item's name ("Flat white" → coffee), so most items need no picking. */
export function guessIcon(name: string): string {
  return GUESSES.find(([re]) => re.test(name))?.[1] ?? 'other'
}

export function ItemIcon({ icon, size = 34 }: { icon?: string | null; size?: number }) {
  const meta = ITEM_ICONS[icon ?? 'other'] ?? ITEM_ICONS.other!
  const tint = tints[meta.tint]
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: tint.bg, alignItems: 'center', justifyContent: 'center' }}>
      <MaterialCommunityIcons name={meta.glyph} size={size * 0.58} color={tint.fg} />
    </View>
  )
}
