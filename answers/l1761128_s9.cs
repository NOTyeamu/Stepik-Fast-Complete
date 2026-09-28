using System;

class Program
{
    static void Main()
    {
        string input = Console.ReadLine();
        string[] parts = input.Split(' ');
        string name = parts[0];
        string surname = parts[1];
        Console.WriteLine($"{surname}, {name}");
    }
}