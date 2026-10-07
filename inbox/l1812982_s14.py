msg = input().strip()
p = input().strip()
if p.isdigit():
    t = int(p)
    for i in range(t):
        print(msg)
else:
    if p == 'true':
        print(msg.upper())
    else:
        print(msg.lower())
