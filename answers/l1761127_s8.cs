using System;

class Program
{
    static void Main()
    {
        string name = Console.ReadLine();
        int age = int.Parse(Console.ReadLine());
        Console.Write($"Привет, {name}! Тебе {age} лет.");
    }
}