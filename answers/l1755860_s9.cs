using System;

class Program
{
    static void Main()
    {
        string name = Console.ReadLine();
        if (name == " ")
        {
            Console.WriteLine("Привет, гость!");
        }
        else
        {
            Console.WriteLine($"Привет, {name}!");
        }
    }
}