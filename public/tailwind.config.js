tailwind.config = {
    darkMode: 'class',
    theme: {
      extend: {
        colors: {
          primary: {"50":"#eff6ff","100":"#dbeafe","200":"#bfdbfe","300":"#93c5fd","400":"#60a5fa","500":"#3b82f6","600":"#2563eb","700":"#1d4ed8","800":"#1e40af","900":"#1e3a8a","950":"#172554"},
          cshsb: {
            // Green: 347433
            green: {
              50: '#e8f5e9',
              100: '#c8e6c9',
              200: '#a5d6a7',
              300: '#81c784',
              400: '#66bb6a',
              500: '#347433',
              600: '#2e6b2e',
              700: '#256325',
              800: '#1c4c1c',
              900: '#133413',
            },
            // Gold/Yellow: FFCF50
            gold: {
              50: '#fffde7',
              100: '#fff9c4',
              200: '#fff59d',
              300: '#fff176',
              400: '#ffeb3b',
              500: '#FFCF50',
              600: '#ffc107',
              700: '#ffb300',
              800: '#ffa000',
              900: '#ff8f00',
            },
            // White
            white: '#ffffff',
            // Black
            black: '#000000'
          }
        }
      },
      fontFamily: {
        'body': [
      'Inter', 
      'ui-sans-serif', 
      'system-ui', 
      '-apple-system', 
      'system-ui', 
      'Segoe UI', 
      'Roboto', 
      'Helvetica Neue', 
      'Arial', 
      'Noto Sans', 
      'sans-serif', 
      'Apple Color Emoji', 
      'Segoe UI Emoji', 
      'Segoe UI Symbol', 
      'Noto Color Emoji'
    ],
        'sans': [
      'Inter', 
      'ui-sans-serif', 
      'system-ui', 
      '-apple-system', 
      'system-ui', 
      'Roboto', 
      'Helvetica Neue', 
      'Arial', 
      'Noto Sans', 
      'sans-serif', 
      'Apple Color Emoji', 
      'Segoe UI Emoji', 
      'Segoe UI Symbol', 
      'Noto Color Emoji'
    ]
      }
    }
  }
