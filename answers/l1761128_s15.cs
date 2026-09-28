using System;

class Program
{
    static void Main()
    {
        string[] parts = Console.ReadLine().Split(' ');
        int num1 = int.Parse(parts[0]);
        int num2 = int.Parse(parts[1]);
        Console.WriteLine(num1 + num2);
    }
}