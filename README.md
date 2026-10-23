# Sparky RISC-V for VS

Edita, ejecuta y depura ensamblador **RISC-V** dentro de VS Code usando el simulador **RARS 1.6 original** (sin modificar). Los registros, el segmento de texto y el segmento de datos se muestran con la misma estructura que en la aplicación de RARS, pero adaptados al tema de colores de VS Code.

## Requisitos

- **Java 8 o superior** (JRE o JDK). La extensión busca `java` en `JAVA_HOME` y en el `PATH`; si no lo encuentra, indica la ruta en el ajuste `sparky.javaPath`.
- VS Code 1.90 o superior.

El simulador (`rars1_6.jar`) ya viene dentro de la extensión: no necesitas tenerlo junto a tus archivos `.asm`.

## Instalación

Desde VS Code: **Extensiones → ⋯ → Instalar desde VSIX…** y elige `sparky-riscv-0.2.0.vsix`, o desde una terminal:

```
code --install-extension sparky-riscv-0.2.0.vsix
```

El mismo `.vsix` se puede copiar a otra computadora e instalar igual.

## Uso rápido

1. Abre un archivo `.asm` o `.s`. VS Code lo reconoce como **RISC-V (Sparky)**. Si otra extensión de ensamblador se queda con `.asm`, cambia el lenguaje con *Cambiar modo de lenguaje* o agrega `"files.associations": { "*.asm": "sparky-riscv" }`.
2. **F5** (o el botón ▶ de la barra del editor) depura el archivo; **Ctrl+F5** lo ejecuta sin depurar. También están los comandos **Sparky: Run Current File** y **Sparky: Debug Current File**.
3. Se abren los paneles de RARS: **Registers** (barra lateral secundaria, a la derecha) y **Text Segment / Data Segment / Labels** (panel inferior). La entrada y salida del programa aparece en la terminal **Sparky I/O**: escribe ahí cuando el programa pida datos (`ReadInt`, `ReadString`…).

### Mientras escribes

- **Colores** según el tema activo: instrucciones, pseudoinstrucciones, saltos, registros, etiquetas, directivas, números, cadenas, comentarios.
- **Errores en tiempo real** con el ensamblador de RARS: subrayado rojo (error) o amarillo (advertencia) con el mismo mensaje que daría RARS. Se revisan ~0.5 s después de dejar de escribir.
- **Ayuda de sintaxis, nunca soluciones.** Hover, autocompletado y ayuda de operandos solo explican **cómo se escribe** cada instrucción y **de qué se compone**: por ejemplo `addi rd, rs1, imm`, con qué es cada parte (`rd` = registro destino, `rs1` = registro fuente, `imm` = constante), el ejemplo y la descripción que da RARS (`addi t1,t2,-100`). Al insertar una instrucción se escriben los nombres de las partes (`rd`, `rs1`, `imm`…), no valores. En cada posición solo se sugiere lo que cabe ahí: registros, registros de punto flotante o etiquetas de tu archivo; si va una constante, no se sugiere nada. La información sale del propio jar, así que coincide con RARS 1.6 y con RV32/RV64. Al pasar el mouse sobre `ecall` se muestra el servicio de la syscall (según el valor que cargaste en `a7`).
- **Sin código sugerido.** No hay *snippets* ni esqueletos de programa, y para este lenguaje la extensión desactiva las sugerencias en línea de VS Code (el texto gris que propone líneas completas, como las de Copilot) y las sugerencias por palabras del archivo. Si quieres volver a activarlas: `"[sparky-riscv]": { "editor.inlineSuggest.enabled": true }` en tus ajustes.

### Plegar funciones

Para poder contraer una función en el margen del editor, escribe `#fn` en la línea de su etiqueta y `#endfn` donde termina:

```
factorial:   #fn
    addi sp, sp, -8
    sw   ra, 0(sp)
    ...
    ret
#endfn
```

- El inicio también puede ir solo, en la línea de arriba de la etiqueta (`#fn factorial`).
- Al plegar queda visible la línea de la etiqueta; el resto, hasta `#endfn`, se contrae. Plegar todo: **Ctrl+K Ctrl+0**; desplegar todo: **Ctrl+K Ctrl+J**.
- Los bloques `.macro` … `.end_macro` se pliegan igual.
- `#fn` y `#endfn` son comentarios para RARS, así que no cambian el programa. Se resaltan con otro color que un comentario normal.

### Depurador

- Breakpoints en el margen del editor (o con la casilla **Bkpt** del Text Segment), paso a paso por instrucción (F10/F11), continuar, pausar, **salir de la función** (Step Out) y **paso atrás** (Step Back / Reverse Continue).
- Los registros (enteros, punto flotante y CSR) aparecen en *Variables*; puedes editarlos. Expresiones útiles en *Watch*: `a0`, `sp+4`, `factorial` (dirección de una etiqueta), `mem[sp]` o `*0x10010000`.
- Desensamblado (*Disassembly View*) y lectura/escritura de memoria (*Memory Inspector*) con el mismo código máquina del segmento de texto.
- Al terminar el programa, los paneles siguen mostrando el estado final (como en RARS) hasta que inicies otra ejecución.

### Paneles estilo RARS

| Panel | Contenido |
|---|---|
| **Registers** | Pestañas *Registers*, *Floating Point* y *Control and Status*; hexadecimal/decimal; el último valor cambiado se resalta; doble clic para editar. |
| **Text Segment** | Bkpt · Address · Code · Basic · Source; la instrucción actual (`pc`) está resaltada; doble clic en *Source* abre la línea en el editor. |
| **Data Segment** | Address + Value (+0) … (+1c); selector de región (`.data`, `current sp`, `current gp`, `.text`, heap, `.extern`, kernel, MMIO), ir a dirección o etiqueta, hex/decimal/ASCII; las palabras que acaba de escribir el programa se resaltan; doble clic para editar. |
| **Labels** | Tabla de símbolos; clic en una etiqueta para verla en el Text o Data Segment. |

Puedes mover cualquier panel: arrástralo a otra zona de VS Code, a una pestaña del editor o a otra ventana/monitor.

## Ajustes (`sparky.*`)

| Ajuste | Descripción |
|---|---|
| `javaPath`, `jarPath` | Ejecutable de Java y, si quieres, otro `rars*.jar`. |
| `lint.enable`, `lint.delay` | Revisión en tiempo real con RARS. |
| `rv64` | RISC-V de 64 bits. |
| `pseudoInstructions` | Permitir pseudoinstrucciones. |
| `startAtMain` | Empezar en la etiqueta global `main` (requiere `.globl main`, como la opción `sm` de RARS). |
| `selfModifyingCode`, `warningsAreErrors`, `memoryConfiguration` | Igual que en RARS. |
| `reverseDebugging` | Guardar historial para *Step Back*. |
| `numberFormat` | Formato de los registros en *Variables* (`hex`, `decimal`, `both`). |
| `showViewsOnDebug` | Abrir los paneles al iniciar una sesión de depuración. |

`launch.json` acepta los mismos valores por configuración (`program`, `extraFiles`, `project`, `stopOnEntry`, `programArguments`, …).

## Limitaciones conocidas

- Las syscalls que abren **diálogos gráficos** (MessageDialog, InputDialog, ConfirmDialog…) no están disponibles; usa las de consola (imprimir/leer entero, cadena, carácter).
- *Step Back* depende del límite de RARS (2000 entradas de historial, unas 400 instrucciones recientes).
- Solo hay una sesión de simulación a la vez.
- Con varios archivos, la revisión en vivo analiza cada archivo por separado: una etiqueta definida en otro archivo puede marcarse como no definida hasta que ejecutes en modo proyecto (`"project": true` o `extraFiles`).
- RARS reporta los errores por pasadas: algunos solo aparecen cuando corriges los anteriores.

## Desarrollo

```
npm install
npm run build          # compila el puente Java (javac) y empaqueta la extensión (esbuild)
npm run typecheck
npm test               # puente Java contra el jar + adaptador de depuración + paneles (jsdom)
npm run test:integration -- "<ruta a Code.exe>"   # dentro de un VS Code real, perfil aislado
npm run package        # genera el .vsix
```

Pulsa **F5** en este proyecto para abrir una ventana *Extension Development Host*.

Arquitectura: la extensión (TypeScript) habla por JSON con `java/RarsBridge.java`, un puente de unas cientos de líneas que llama a las clases internas de `rars1_6.jar` (`RISCVprogram`, `Simulator`, `BackStepper`, `RegisterFile`, `Memory`, `SystemIO`). Toda la lógica de ensamblado y simulación es la de RARS.

## Licencias

Código de esta extensión: MIT (ver `LICENSE`). RARS es de Pete Sanderson y Kenneth Vollmar, con licencia MIT (ver `lib/RARS-License.txt`).
