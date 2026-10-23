# Test file for function folding. It is also a valid program: F5 prints 120, 10, 7 and a string.
# Try: Ctrl+K Ctrl+0 (fold all), Ctrl+K Ctrl+J (unfold all), and the arrows in the gutter.
#
# What to check in each case is written next to it.

.data
msg:    .asciz "a #fn inside a string does not start a fold\n"
nl:     .asciz "\n"

.text

# Case 1: .macro ... .end_macro keeps folding as before.
.macro print_str(%s)
    la   a0, %s
    li   a7, 4
    ecall
.end_macro

# Case 2: label and #fn on the same line. Folded, only "main: #fn" stays visible.
main:   #fn
    li   a0, 5
    jal  ra, factorial
    jal  ra, show
    li   a0, 4
    jal  ra, sum_to
    jal  ra, show
    jal  ra, flat_seven
    jal  ra, show
    print_str(msg)
    li   a7, 10
    ecall
#endfn

# Case 3: #fn on its own line above the label (two nested folds: the whole block and the label body).
#fn factorial
factorial:
    addi sp, sp, -8
    sw   ra, 4(sp)
    sw   a0, 0(sp)
    li   t0, 2
    blt  a0, t0, fact_base
    addi a0, a0, -1
    jal  ra, factorial
    lw   t1, 0(sp)
    mul  a0, a0, t1
    j    fact_end
fact_base:
    li   a0, 1
fact_end:
    lw   ra, 4(sp)
    addi sp, sp, 8
    ret
#endfn

# Case 4: inner labels (loops) must not break the outer fold; the whole function folds up to #endfn.
sum_to: #fn
    li   t0, 0
    li   t1, 0
sum_loop:
    bgt  t1, a0, sum_done
    add  t0, t0, t1
    addi t1, t1, 1
    j    sum_loop
sum_done:
    mv   a0, t0
    ret
#endfn

# Case 5: body without indentation. Folding by indentation cannot fold this; the markers can.
flat_seven: #fn
li   a0, 7
ret
#endfn

# Case 6: no markers, indented body. It still folds by indentation (label line stays visible).
show:
    li   a7, 1
    ecall
    la   a0, nl
    li   a7, 4
    ecall
    ret

# Case 7: this line looks like a marker but is not one, so it must not create a fold
# and must be colored as a normal comment (compare it with the #fn lines above):
#fnord
