using System;

class Program
{
    static void Main()
    {
        string name = Console.ReadLine();
        string surname = Console.ReadLine();
        string patronymic = Console.ReadLine();
        Console.WriteLine($"{surname} {name} {patronymic}");
    }
}