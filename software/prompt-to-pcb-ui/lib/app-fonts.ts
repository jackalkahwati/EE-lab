import { Inter, JetBrains_Mono } from 'next/font/google'

const inter = Inter({ variable: '--font-inter', subsets: ['latin'] })
const jetbrainsMono = JetBrains_Mono({ variable: '--font-jetbrains-mono', subsets: ['latin'] })

export const appFontClasses = `${inter.variable} ${jetbrainsMono.variable}`
export const appFontStyle = undefined
