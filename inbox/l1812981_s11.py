def CountVowels(word):
    vowels = "aeiou"
    count = 0
    for char in word.lower():
        if char in vowels:
            count += 1
    return count

word = input()
print(CountVowels(word))